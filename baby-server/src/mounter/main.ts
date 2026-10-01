// 挂载服务（nas-mounter 容器）：按宝宝相册的指令挂载、卸载存储，支持 SMB、NFS、WebDAV。
//
// 为什么单独一个容器：挂载需要 SYS_ADMIN 权限。把它放在一个不对外开放、只通过 socket 文件
// 接收指令的小容器里，对外提供网页服务的宝宝相册本身就不需要任何特殊权限。
//
// 关键设计（在 OrbStack 上实测过）：
//   - 使用主机网络（network_mode: host）。SMB、NFS 由内核挂载，连接属于发起挂载的网络命名空间；
//     用主机网络，挂载服务重启或退出后，这两种挂载照样可用
//   - WebDAV 内核不支持，用 rclone 通过 FUSE 挂载。FUSE 挂载依赖 rclone 进程，挂载服务重启后会失效，
//     宝宝相册从 /status 里的 startedAt 发现挂载服务重启过，会立即重新挂载
//   - 挂载点在一个设置了 rshared 传播的目录下，Immich 和宝宝相册以 rslave 挂载同一个目录，
//     运行时新增的挂载会自动出现在它们里面，不需要重启任何容器
//
// 目录结构（宿主机上的 /var/lib/babyalbum，在本容器里是 /host）：
//   /host/nas/<编号>   照片存储（只读）→ Immich、宝宝相册的 /mnt/nas/<编号>
//   /host/backup       备份位置（可写）→ Immich 的 /data/backups、宝宝相册的 /backups
//
// 控制接口（HTTP over unix socket，/run/mounter/mounter.sock）：
//   GET  /status                  挂载服务启动时间 + 所有挂载的状态
//   POST /mount   {target, ...}   挂载（已经挂好且可用就跳过）
//   POST /unmount {target}        卸载
//   POST /test    {...}           测试连接：返回顶层文件夹；writable 时测试能否写入

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { mkdtemp, readdir, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HOST_DIR = '/host';
const SOCKET = '/run/mounter/mounter.sock';
const startedAt = new Date().toISOString();

export type MountRequest = {
  /** nas/<编号> 或 backup */
  target: string;
  protocol: 'smb' | 'nfs' | 'webdav';
  /** SMB、NFS：服务器地址 */
  host?: string;
  /** SMB：共享名；NFS：共享路径（export，比如 /volume1/photos） */
  share?: string;
  /** WebDAV：完整地址，比如 https://dav.example.com/dav */
  url?: string;
  /** 存储里的子目录，可以为空 */
  subPath?: string;
  username?: string;
  password?: string;
  /** SMB 协议版本（默认 3.0）或 NFS 版本（默认 4.1） */
  vers?: string;
  writable?: boolean;
};

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

class UserError extends Error {}

// ---------------------------------------------------------------- 工具

/** 只允许 nas/<编号> 和 backup 两种目标，防止挂到别的地方 */
function targetDir(target: string) {
  if (target === 'backup' || /^nas\/[A-Za-z0-9_-]{1,40}$/.test(target)) return join(HOST_DIR, target);
  throw new UserError('挂载目标无效');
}

const cleanSub = (subPath = '') => {
  const sub = subPath.replace(/^\/+|\/+$/g, '');
  if (sub.split('/').includes('..')) throw new UserError('路径无效');
  return sub;
};

/** cifs 选项里逗号要写成两个逗号 */
const escapeOpt = (v: string) => v.replaceAll(',', ',,');

function mountsAt(dir: string) {
  return readFileSync('/proc/self/mounts', 'utf8')
    .split('\n')
    .filter((l) => l.split(' ')[1] === dir.replaceAll(' ', '\\040'));
}

/** 带超时的检查：失效的网络挂载访问时可能卡住 */
async function healthy(dir: string, timeoutMs = 8000): Promise<boolean> {
  return Promise.race([
    readdir(dir).then(() => true, () => false),
    new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
  ]);
}

/** WebDAV 挂载对应的 rclone 进程（挂载目录 → 进程） */
const rcloneProcs = new Map<string, ChildProcess>();

async function unmountAll(dir: string) {
  const proc = rcloneProcs.get(dir);
  if (proc) {
    proc.kill('SIGTERM');
    rcloneProcs.delete(dir);
  }
  // 可能叠了好几层（之前失效的挂载），-l 懒卸载不会因为连不上服务器而卡住
  for (let i = 0; i < 5 && mountsAt(dir).length; i++) await run('umount', ['-l', dir]).catch(() => {});
}

async function resolveHost(host?: string) {
  if (!host) throw new UserError('请填写地址');
  // 内核挂载不会解析主机名，这里先解析成 IP
  const { address } = await lookup(host, { family: 4 }).catch(() => {
    throw new UserError(`解析不了地址 ${host}`);
  });
  return address;
}

const UNREACHABLE = '连不上存储服务器，请检查地址和网络；如果宝宝相册运行在 Mac 上，还要在“系统设置 → 隐私与安全性 → 本地网络”里允许 Docker（如 OrbStack）';

function smbError(stderr: string) {
  const s = stderr.toLowerCase();
  if (s.includes('permission denied') || s.includes('error(13)')) return '用户名或密码错误，或者这个账号没有访问这个共享的权限';
  if (s.includes('no such file') || s.includes('error(2)')) return '找不到这个共享或文件夹，请检查共享名和路径';
  if (s.includes('host is down') || s.includes('error(112)') || s.includes('no route') || s.includes('timed out') || s.includes('error(115)') || s.includes('in progress'))
    return UNREACHABLE;
  if (s.includes('connection refused') || s.includes('error(111)')) return '服务器拒绝了连接，请确认开启了 SMB（Samba）服务';
  if (s.includes('operation not supported') || s.includes('error(95)')) return 'SMB 协议版本不兼容，可以试试把版本改成 2.1 或 3.1.1';
  return stderr.trim().split('\n').pop() || '挂载失败';
}

function nfsError(stderr: string) {
  const s = stderr.toLowerCase();
  if (s.includes('access denied') || s.includes('permission denied')) return '服务器拒绝访问：请在 NFS 设置里允许运行宝宝相册的这台设备的 IP';
  if (s.includes('no such file')) return '找不到这个共享路径，请检查路径（比如 /volume1/photos）';
  if (s.includes('connection refused')) return '服务器拒绝了连接，请确认开启了 NFS 服务';
  if (s.includes('timed out') || s.includes('no route') || s.includes('unreachable')) return UNREACHABLE;
  if (s.includes('protocol not supported') || s.includes('requested nfs version')) return 'NFS 版本不兼容，可以试试别的版本';
  return stderr.trim().split('\n').pop() || '挂载失败';
}

function webdavError(output: string) {
  const s = output.toLowerCase();
  if (s.includes('401') || s.includes('unauthorized')) return '用户名或密码错误';
  if (s.includes('403') || s.includes('forbidden')) return '这个账号没有访问权限';
  if (s.includes('404') || s.includes('not found') || s.includes('directory not found')) return '找不到这个地址或文件夹，请检查地址和路径';
  if (s.includes('no such host') || s.includes('connection refused') || s.includes('timeout') || s.includes('unreachable')) return UNREACHABLE;
  if (s.includes('certificate')) return 'HTTPS 证书无效';
  return output.trim().split('\n').filter((l) => !l.includes('NOTICE')).pop() || '连接失败';
}

// ---------------------------------------------------------------- WebDAV（rclone）

/** rclone 的参数全部通过环境变量传，避免地址里的冒号、逗号等需要转义 */
async function rcloneEnv(req: MountRequest) {
  if (!req.url || !/^https?:\/\//.test(req.url)) throw new UserError('WebDAV 地址要以 http:// 或 https:// 开头');
  const { stdout } = await run('rclone', ['obscure', '--', req.password ?? '']);
  return {
    ...process.env,
    RCLONE_CONFIG: '/dev/null',
    RCLONE_WEBDAV_URL: req.url,
    RCLONE_WEBDAV_VENDOR: 'other',
    RCLONE_WEBDAV_USER: req.username ?? '',
    RCLONE_WEBDAV_PASS: stdout.trim(),
  };
}

const rcloneRemote = (req: MountRequest) => `:webdav:${cleanSub(req.subPath)}`;

async function mountWebdav(req: MountRequest, dir: string) {
  const env = await rcloneEnv(req);
  // --allow-non-empty：挂载点下可能已有文件（比如备份位置原来在本机时留下的备份），和 SMB、NFS 一样直接盖在上面
  const args = ['mount', rcloneRemote(req), dir, '--allow-other', '--allow-non-empty', '--dir-cache-time', '5m', '--log-level', 'ERROR'];
  // 只读挂载不需要缓存；可写（备份）要用写缓存，否则很多程序的写法 WebDAV 不支持
  args.push(...(req.writable ? ['--vfs-cache-mode', 'writes'] : ['--read-only', '--vfs-cache-mode', 'off']));
  const proc = spawn('rclone', args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr!.on('data', (c) => (stderr += c));
  // 等挂载出现（rclone 前台运行，挂好之后会一直在）
  const ok = await new Promise<boolean>((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (mountsAt(dir).length) {
        clearInterval(timer);
        resolve(true);
      } else if (proc.exitCode !== null || Date.now() - started > 30_000) {
        clearInterval(timer);
        resolve(false);
      }
    }, 300);
  });
  if (!ok) {
    proc.kill('SIGTERM');
    throw new UserError(webdavError(stderr || '连接超时'));
  }
  rcloneProcs.set(dir, proc);
  proc.on('exit', () => {
    if (rcloneProcs.get(dir) === proc) rcloneProcs.delete(dir);
  });
}

// ---------------------------------------------------------------- 挂载

async function doMount(req: MountRequest, dir: string) {
  mkdirSync(dir, { recursive: true });
  const sub = cleanSub(req.subPath);

  if (req.protocol === 'webdav') return mountWebdav(req, dir);

  const address = await resolveHost(req.host);
  if (!req.share) throw new UserError(req.protocol === 'nfs' ? '请填写共享路径' : '请填写共享名');

  let args: string[];
  if (req.protocol === 'nfs') {
    const exportPath = `/${req.share.replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
    const source = `${address}:${exportPath || '/'}${sub ? `/${sub}` : ''}`;
    const vers = req.vers || '4.1';
    // soft：服务器断开时报错而不是无限等待
    const opts = [req.writable ? 'rw' : 'ro', `vers=${vers}`, 'soft', 'timeo=100', 'retrans=3'];
    if (vers.startsWith('3')) opts.push('nolock');
    args = ['-t', 'nfs', source, dir, '-o', opts.join(',')];
  } else {
    if (!req.username) throw new UserError('请填写用户名');
    const source = `//${address}/${req.share}${sub ? `/${sub}` : ''}`;
    const opts = [
      `addr=${address}`,
      `username=${escapeOpt(req.username)}`,
      `password=${escapeOpt(req.password ?? '')}`,
      req.writable ? 'rw' : 'ro',
      `vers=${req.vers || '3.0'}`,
      'iocharset=utf8',
      'uid=0',
      'gid=0',
      req.writable ? 'file_mode=0644,dir_mode=0755' : 'file_mode=0444,dir_mode=0555',
      // 服务器断开时报错而不是无限等待；10 秒心跳，断开后能尽快发现
      'soft',
      'echo_interval=10',
    ].join(',');
    args = ['-t', 'cifs', source, dir, '-o', opts];
  }

  try {
    await run('mount', args, { timeout: 30_000 });
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean };
    if (e.killed) throw new UserError(UNREACHABLE);
    const msg = e.stderr ?? String(err);
    throw new UserError(req.protocol === 'nfs' ? nfsError(msg) : smbError(msg));
  }
}

// ---------------------------------------------------------------- 接口

async function status() {
  const mounts: Record<string, { mounted: boolean; healthy: boolean; writable: boolean }> = {};
  const dirs = ['backup', ...(existsSync(join(HOST_DIR, 'nas')) ? (await readdir(join(HOST_DIR, 'nas'))).map((d) => `nas/${d}`) : [])];
  for (const target of dirs) {
    const dir = join(HOST_DIR, target);
    const list = mountsAt(dir);
    if (!list.length) {
      mounts[target] = { mounted: false, healthy: false, writable: false };
      continue;
    }
    mounts[target] = { mounted: true, healthy: await healthy(dir), writable: / rw[ ,]/.test(` ${list.at(-1)!.split(' ')[3]}`) };
  }
  return { startedAt, mounts };
}

async function mount(req: MountRequest) {
  const dir = targetDir(req.target);
  // 已经挂好、而且能正常访问：不重复挂载（挂载服务重启后，SMB、NFS 的挂载照样可用）
  if (mountsAt(dir).length && (await healthy(dir))) return { ok: true, reused: true };
  await unmountAll(dir);
  await doMount(req, dir);
  const where = req.protocol === 'webdav' ? req.url : `${req.host}/${req.share}`;
  log('已挂载', req.target, req.protocol, `${where}/${req.subPath ?? ''}`, req.writable ? '读写' : '只读');
  return { ok: true, reused: false };
}

async function unmount(target: string) {
  const dir = targetDir(target);
  await unmountAll(dir);
  // 只删空的挂载点目录；删不掉（比如还有残留挂载）就留着，不影响
  if (target !== 'backup') {
    try {
      rmdirSync(dir);
    } catch {}
  }
  log('已卸载', target);
  return { ok: true };
}

/** 测试连接：返回顶层文件夹；writable 时顺便测试能否写入。不会影响共享目录 */
async function test(req: MountRequest) {
  if (req.protocol === 'webdav') {
    // WebDAV 不用真的挂载，直接用 rclone 列目录、写测试文件
    const env = await rcloneEnv(req);
    const remote = rcloneRemote(req);
    try {
      const { stdout } = await run('rclone', ['lsf', '--dirs-only', remote], { env, timeout: 30_000 });
      if (req.writable) {
        const probe = `${remote}${remote.endsWith(':') ? '' : '/'}.babyalbum-write-test-${Date.now()}`;
        await run('rclone', ['touch', probe], { env, timeout: 30_000 }).catch(() => {
          throw new UserError('能连上，但这个账号没有写入权限');
        });
        await run('rclone', ['deletefile', probe], { env, timeout: 30_000 }).catch(() => {});
      }
      const folders = stdout.split('\n').map((l) => l.replace(/\/$/, '')).filter((n) => n && !/^[.@#]/.test(n));
      return { ok: true, folders: folders.slice(0, 200) };
    } catch (err) {
      if (err instanceof UserError) throw err;
      const e = err as { stderr?: string; killed?: boolean };
      throw new UserError(e.killed ? UNREACHABLE : webdavError(e.stderr ?? String(err)));
    }
  }

  const dir = await mkdtemp('/tmp/storage-test-');
  try {
    await doMount(req, dir);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      if (req.writable) {
        const probe = join(dir, `.babyalbum-write-test-${Date.now()}`);
        await writeFile(probe, 'ok').catch(() => {
          throw new UserError('能连上，但这个账号没有写入权限');
        });
        await unlink(probe).catch(() => {});
      }
      return { ok: true, folders: entries.filter((e) => e.isDirectory() && !/^[.@#]/.test(e.name)).map((e) => e.name).slice(0, 200) };
    } finally {
      await unmountAll(dir);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- HTTP over unix socket

async function body(req: IncomingMessage) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/status') return send(res, 200, await status());
    if (req.method === 'POST' && req.url === '/mount') return send(res, 200, await mount(await body(req)));
    if (req.method === 'POST' && req.url === '/unmount') return send(res, 200, await unmount((await body(req)).target));
    if (req.method === 'POST' && req.url === '/test') return send(res, 200, await test(await body(req)));
    send(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof UserError) return send(res, 400, { error: err.message });
    log('出错', err);
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

mkdirSync(join(HOST_DIR, 'nas'), { recursive: true });
mkdirSync(join(HOST_DIR, 'backup'), { recursive: true });
mkdirSync('/run/mounter', { recursive: true });
if (existsSync(SOCKET)) unlinkSync(SOCKET);
server.listen(SOCKET, () => {
  chmodSync(SOCKET, 0o600);
  log('挂载服务已启动', SOCKET);
});
// 退出时停掉 rclone（WebDAV 挂载随之失效，下次启动后由宝宝相册重新挂载）
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const p of rcloneProcs.values()) p.kill('SIGTERM');
    server.close(() => process.exit(0));
  });
}
