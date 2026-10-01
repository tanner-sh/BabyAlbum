// 挂载服务（nas-mounter 容器）：按宝宝相册的指令挂载、卸载 NAS 上的 SMB 共享。
//
// 为什么单独一个容器：挂载需要 SYS_ADMIN 权限。把它放在一个不对外开放、只通过 socket 文件
// 接收指令的小容器里，对外提供网页服务的宝宝相册本身就不需要任何特殊权限。
//
// 关键设计（在 OrbStack 上实测过）：
//   - 使用主机网络（network_mode: host）。内核的 SMB 连接属于发起挂载的网络命名空间；
//     用主机网络，挂载服务重启或退出后，已有的挂载照样可用，不会变成“Host is down”
//   - 挂载点在一个设置了 rshared 传播的目录下，Immich 和宝宝相册以 rslave 挂载同一个目录，
//     运行时新增的挂载会自动出现在它们里面，不需要重启任何容器
//
// 目录结构（宿主机上的 /var/lib/babyalbum，在本容器里是 /host）：
//   /host/nas/<名称>   照片来源（只读）→ Immich、宝宝相册的 /mnt/nas/<名称>
//   /host/backup       备份位置（可写）→ Immich 的 /data/backups、宝宝相册的 /backups
//
// 控制接口（HTTP over unix socket，/run/mounter/mounter.sock）：
//   GET  /status                  所有挂载的状态
//   POST /mount   {target, ...}   挂载（已经挂好且可用就跳过）
//   POST /unmount {target}        卸载
//   POST /test    {...}           试挂载到临时目录，返回顶层文件夹，然后卸载（用于“测试连接”）

import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { mkdtemp, readdir, writeFile, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HOST_DIR = '/host';
const SOCKET = '/run/mounter/mounter.sock';

export type MountRequest = {
  /** nas/<名称> 或 backup */
  target: string;
  host: string;
  share: string;
  /** 共享里的子目录，可以为空 */
  subPath?: string;
  username: string;
  password: string;
  /** SMB 协议版本，默认 3.0 */
  vers?: string;
  writable?: boolean;
};

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

// ---------------------------------------------------------------- 工具

/** 只允许 nas/<名称> 和 backup 两种目标，防止挂到别的地方 */
function targetDir(target: string) {
  if (target === 'backup' || /^nas\/[A-Za-z0-9_-]{1,40}$/.test(target)) return join(HOST_DIR, target);
  throw new UserError('挂载目标无效');
}

class UserError extends Error {}

/** cifs 选项里逗号要写成两个逗号 */
const escapeOpt = (v: string) => v.replaceAll(',', ',,');

function mountsAt(dir: string) {
  return readFileSync('/proc/self/mounts', 'utf8')
    .split('\n')
    .filter((l) => l.split(' ')[1] === dir.replaceAll(' ', '\\040'));
}

/** 带超时的检查：失效的 SMB 挂载访问时可能卡住 */
async function healthy(dir: string, timeoutMs = 8000): Promise<boolean> {
  return Promise.race([
    readdir(dir).then(() => true, () => false),
    new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
  ]);
}

async function unmountAll(dir: string) {
  // 可能叠了好几层（之前失效的挂载），-l 懒卸载不会因为连不上 NAS 而卡住
  for (let i = 0; i < 5 && mountsAt(dir).length; i++) await run('umount', ['-l', dir]).catch(() => {});
}

function friendlyError(stderr: string) {
  const s = stderr.toLowerCase();
  if (s.includes('permission denied') || s.includes('error(13)')) return '用户名或密码错误，或者这个账号没有访问这个共享的权限';
  if (s.includes('no such file') || s.includes('error(2)')) return '找不到这个共享或文件夹，请检查共享名和路径';
  if (s.includes('host is down') || s.includes('error(112)') || s.includes('no route') || s.includes('timed out') || s.includes('error(115)') || s.includes('in progress'))
    return '连不上 NAS，请检查地址；在 Mac 上还要在“系统设置 → 隐私与安全性 → 本地网络”里允许 OrbStack';
  if (s.includes('connection refused') || s.includes('error(111)')) return 'NAS 拒绝了连接，请确认 NAS 开启了 SMB（Samba）服务';
  if (s.includes('operation not supported') || s.includes('error(95)')) return 'SMB 协议版本不兼容，可以试试把版本改成 2.1 或 3.1.1';
  return stderr.trim().split('\n').pop() || '挂载失败';
}

async function doMount(req: MountRequest, dir: string) {
  if (!req.host || !req.share || !req.username) throw new UserError('地址、共享名、用户名都要填');
  // 内核挂载不会解析主机名，这里先解析成 IP
  const { address } = await lookup(req.host, { family: 4 }).catch(() => {
    throw new UserError(`解析不了地址 ${req.host}`);
  });
  const sub = (req.subPath ?? '').replace(/^\/+|\/+$/g, '');
  if (sub.split('/').includes('..')) throw new UserError('路径无效');
  const source = `//${address}/${req.share}${sub ? `/${sub}` : ''}`;
  const opts = [
    `addr=${address}`,
    `username=${escapeOpt(req.username)}`,
    `password=${escapeOpt(req.password)}`,
    req.writable ? 'rw' : 'ro',
    `vers=${req.vers || '3.0'}`,
    'iocharset=utf8',
    'uid=0',
    'gid=0',
    req.writable ? 'file_mode=0644,dir_mode=0755' : 'file_mode=0444,dir_mode=0555',
    // NAS 断开时报错而不是无限等待；10 秒心跳，断开后能尽快发现
    'soft',
    'echo_interval=10',
  ].join(',');
  mkdirSync(dir, { recursive: true });
  try {
    await run('mount', ['-t', 'cifs', source, dir, '-o', opts], { timeout: 30_000 });
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean };
    throw new UserError(e.killed ? '连接 NAS 超时' : friendlyError(e.stderr ?? String(err)));
  }
}

// ---------------------------------------------------------------- 接口

async function status() {
  const result: Record<string, { mounted: boolean; healthy: boolean; writable: boolean }> = {};
  const dirs = ['backup', ...(existsSync(join(HOST_DIR, 'nas')) ? (await readdir(join(HOST_DIR, 'nas'))).map((d) => `nas/${d}`) : [])];
  for (const target of dirs) {
    const dir = join(HOST_DIR, target);
    const mounts = mountsAt(dir);
    if (!mounts.length) {
      result[target] = { mounted: false, healthy: false, writable: false };
      continue;
    }
    result[target] = { mounted: true, healthy: await healthy(dir), writable: / rw[ ,]/.test(` ${mounts.at(-1)!.split(' ')[3]}`) };
  }
  return result;
}

async function mount(req: MountRequest) {
  const dir = targetDir(req.target);
  // 已经挂好、而且能正常访问：不重复挂载（挂载服务重启后，已有挂载照样可用）
  if (mountsAt(dir).length && (await healthy(dir))) {
    return { ok: true, reused: true };
  }
  await unmountAll(dir);
  await doMount(req, dir);
  log('已挂载', req.target, `//${req.host}/${req.share}/${req.subPath ?? ''}`, req.writable ? '读写' : '只读');
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

/** 试挂载到临时目录（不在共享目录下，不会传播出去），返回顶层文件夹；可写的话顺便测试写入 */
async function test(req: MountRequest) {
  const dir = await mkdtemp('/tmp/nas-test-');
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
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
