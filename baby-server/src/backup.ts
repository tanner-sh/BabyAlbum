// 每日备份 SQLite 数据库（宝宝档案、里程碑、分享链接）到 BACKUP_DIR，保留最近 14 份。
// 用 VACUUM INTO 生成一致的快照，服务运行中也可以安全备份。

import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { localToday } from './age.ts';
import { db, settings } from './db.ts';

const KEEP = 14;
const PREFIX = 'baby-';

export function backupNow(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${PREFIX}${localToday()}.db`);
  rmSync(file, { force: true });
  db.prepare('VACUUM INTO ?').run(file);
  const old = readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith('.db'))
    .sort()
    .slice(0, -KEEP);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return file;
}

export function scheduleBackups(dir: string, log: FastifyBaseLogger) {
  const run = () => {
    // 记下最近一次的结果，系统状态页用
    try {
      log.info(`数据库已备份到 ${backupNow(dir)}`);
      settings.set('backup.lastOk', new Date().toISOString());
      settings.remove('backup.lastError');
    } catch (err) {
      log.error(err, '数据库备份失败');
      settings.set('backup.lastError', JSON.stringify({ at: new Date().toISOString(), message: err instanceof Error ? err.message : String(err) }));
    }
  };
  run();
  setInterval(run, 24 * 3600 * 1000).unref();
}
