// 统计 Immich 数据目录（缩略图、转码视频等）占了多少空间。
// Immich 的接口只给整块磁盘的用量，所以宝宝相册以只读方式挂载 Immich 的数据卷，在后台定期统计。
// 缩略图可能有几十万个文件，统计放在后台做、结果缓存起来，打开管理页面时不会变慢。

import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.ts';

const REFRESH_MS = 10 * 60_000;
const CONCURRENCY = 8;

let latest: { bytes: number; computedAt: string } | null = null;

export const immichDataUsage = () => latest;

/** 递归统计目录大小。数据库备份在另一个挂载点上（可能是 NAS），不算在内 */
function dirSize(root: string): Promise<number> {
  const skip = join(root, 'backups');
  const queue = [root];
  let total = 0;
  let active = 0;

  return new Promise((resolve) => {
    const scan = async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (full !== skip) queue.push(full);
        } else if (e.isFile()) {
          // 先等到结果再累加：写成 total += await … 会在等待前读出旧的 total，并发时互相覆盖
          const size = (await lstat(full).catch(() => null))?.size ?? 0;
          total += size;
        }
      }
    };
    // 队列空了不代表结束：可能还有目录正在读、会再放进新的子目录
    const pump = () => {
      if (!queue.length && active === 0) return resolve(total);
      while (active < CONCURRENCY && queue.length) {
        active++;
        void scan(queue.pop()!).finally(() => {
          active--;
          pump();
        });
      }
    };
    pump();
  });
}

export function startStorageUsage(log: FastifyBaseLogger) {
  const run = async () => {
    try {
      latest = { bytes: await dirSize(config.IMMICH_DATA_DIR), computedAt: new Date().toISOString() };
    } catch (err) {
      log.warn(err, '统计 Immich 数据大小失败');
    }
  };
  void run();
  setInterval(run, REFRESH_MS).unref();
}
