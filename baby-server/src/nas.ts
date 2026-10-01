// 存储连接管理（SMB / NFS / WebDAV）：把管理员在网页上配置的存储交给挂载服务（nas-mounter）挂载，
// 并定期检查、自动重连。
//   照片来源 → /mnt/nas/<id>（只读，Immich 和宝宝相册都能看到）
//   备份位置 → Immich 的 /data/backups、宝宝相册的 /backups（可写）

import { request } from 'node:http';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.ts';
import { nasSources, settings, type NasSource } from './db.ts';

export type MountState = { state: 'ok' | 'error' | 'pending'; error: string | null; checkedAt: string | null };
export type BackupTarget = { sourceId: number; subPath: string };

type MounterStatus = { startedAt: string; mounts: Record<string, { mounted: boolean; healthy: boolean; writable: boolean }> };

const states = new Map<string, MountState>();
let mounterAvailable = false;
let lastMounterStart: string | null = null;

export const nasTarget = (id: number) => `nas/${id}`;
export const nasMountPath = (id: number) => `${config.NAS_ROOT}/${id}`;
export const mountState = (target: string): MountState => states.get(target) ?? { state: 'pending', error: null, checkedAt: null };
export const isMounterAvailable = () => mounterAvailable;

// ---------------------------------------------------------------- 调用挂载服务（unix socket）

class MounterError extends Error {
  /** true：可以直接显示给用户的错误（密码错误、连不上之类） */
  userFacing: boolean;
  constructor(message: string, userFacing: boolean) {
    super(message);
    this.userFacing = userFacing;
  }
}

function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      { socketPath: config.MOUNTER_SOCKET, method, path, headers: payload ? { 'content-type': 'application/json' } : {}, timeout: 60_000 },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          const data = raw ? JSON.parse(raw) : {};
          if (res.statusCode === 200) resolve(data as T);
          else reject(new MounterError(data.error ?? `挂载服务出错（${res.statusCode}）`, res.statusCode === 400));
        });
      },
    );
    req.on('error', () => reject(new MounterError('挂载服务没有运行，请检查 nas-mounter 容器', true)));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

type Connection = Pick<NasSource, 'protocol' | 'host' | 'share' | 'url' | 'username' | 'password' | 'vers'>;

const mountBody = (src: Connection, subPath: string, writable = false) => ({
  protocol: src.protocol,
  host: src.host,
  share: src.share,
  url: src.url,
  subPath,
  username: src.username,
  password: src.password,
  vers: src.vers,
  writable,
});

/** 存储里的子目录 + 额外的子目录（备份位置是在存储的子目录下再选一个文件夹） */
export const joinSub = (...parts: string[]) => parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

// ---------------------------------------------------------------- 对外接口

/** 测试连接：试挂载后返回共享里的顶层文件夹；writable 时还会测试能否写入 */
export function testConnection(src: Connection, subPath: string, writable = false) {
  return call<{ folders: string[] }>('POST', '/test', mountBody(src, subPath, writable));
}

export async function mountSource(src: NasSource) {
  const target = nasTarget(src.id);
  try {
    await call('POST', '/mount', { target, ...mountBody(src, src.subPath) });
    states.set(target, { state: 'ok', error: null, checkedAt: new Date().toISOString() });
  } catch (err) {
    states.set(target, { state: 'error', error: (err as Error).message, checkedAt: new Date().toISOString() });
    throw err;
  }
}

export async function unmountSource(id: number) {
  await call('POST', '/unmount', { target: nasTarget(id) });
  states.delete(nasTarget(id));
}

export function getBackupTarget(): BackupTarget | null {
  const raw = settings.get('backup.target');
  return raw ? JSON.parse(raw) : null;
}

/** 设置备份位置：先测试能否写入，再以可写方式挂载；传 null 表示改回本机 */
export async function setBackupTarget(target: BackupTarget | null) {
  if (!target) {
    await call('POST', '/unmount', { target: 'backup' });
    settings.remove('backup.target');
    states.delete('backup');
    return;
  }
  const src = nasSources.get(target.sourceId);
  if (!src) throw new MounterError('存储不存在', true);
  await testConnection(src, joinSub(src.subPath, target.subPath), true);
  await call('POST', '/unmount', { target: 'backup' });
  await call('POST', '/mount', { target: 'backup', ...mountBody(src, joinSub(src.subPath, target.subPath), true) });
  settings.set('backup.target', JSON.stringify(target));
  states.set('backup', { state: 'ok', error: null, checkedAt: new Date().toISOString() });
}

/** 让实际挂载和配置一致：缺的挂上、坏的重连、多余的卸掉 */
export async function reconcile(log: FastifyBaseLogger) {
  let status: MounterStatus['mounts'];
  try {
    const res = await call<MounterStatus>('GET', '/status');
    status = res.mounts;
    if (lastMounterStart && lastMounterStart !== res.startedAt) log.info('挂载服务重启过，检查并恢复挂载（WebDAV 需要重新挂载）');
    lastMounterStart = res.startedAt;
    mounterAvailable = true;
  } catch {
    mounterAvailable = false;
    return;
  }

  const sources = nasSources.list();
  for (const src of sources) {
    const target = nasTarget(src.id);
    if (status[target]?.healthy) {
      states.set(target, { state: 'ok', error: null, checkedAt: new Date().toISOString() });
      continue;
    }
    await mountSource(src).then(
      () => log.info(`存储“${src.name}”已挂载`),
      (err) => log.warn(`存储“${src.name}”挂载失败：${(err as Error).message}`),
    );
  }
  // 配置里已经删掉的 NAS：卸载并删掉空的挂载点目录（只处理数字编号的目录，不碰其他目录）
  const known = new Set(sources.map((s) => nasTarget(s.id)));
  for (const target of Object.keys(status)) {
    if (/^nas\/\d+$/.test(target) && !known.has(target)) await call('POST', '/unmount', { target }).catch(() => {});
  }

  const backup = getBackupTarget();
  const src = backup && nasSources.get(backup.sourceId);
  if (backup && src) {
    if (!(status.backup?.healthy && status.backup.writable)) {
      await call('POST', '/unmount', { target: 'backup' }).catch(() => {});
      await call('POST', '/mount', { target: 'backup', ...mountBody(src, joinSub(src.subPath, backup.subPath), true) }).then(
        () => states.set('backup', { state: 'ok', error: null, checkedAt: new Date().toISOString() }),
        (err) => states.set('backup', { state: 'error', error: (err as Error).message, checkedAt: new Date().toISOString() }),
      );
    } else states.set('backup', { state: 'ok', error: null, checkedAt: new Date().toISOString() });
  } else if (status.backup?.mounted) {
    await call('POST', '/unmount', { target: 'backup' }).catch(() => {});
  }
}

/**
 * 启动后立即同步一次，之后每 20 秒检查一次：断线自动重连；
 * 挂载服务重启后 WebDAV 挂载会失效，最多 20 秒内恢复
 */
export function startNasReconcile(log: FastifyBaseLogger) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    await reconcile(log).catch((err) => log.warn(err, '同步存储挂载失败'));
    running = false;
  };
  void tick();
  setInterval(tick, 20_000).unref();
}

export { MounterError };
