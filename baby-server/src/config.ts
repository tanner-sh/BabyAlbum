import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  IMMICH_URL: z.url().default('http://localhost:2283'),
  // 一般不用填：宝宝相册首次启动时会自动初始化 Immich 并保存密钥。
  // 只有接入一个已经在用的 Immich 时，才可以在这里填一个现成的密钥（也可以在管理页面里用 Immich 管理员账号连接）
  IMMICH_API_KEY: z.string().optional(),
  // NAS 共享在容器里的挂载点（Immich 和宝宝相册挂在同一个路径，管理员在网页上选择导入哪些文件夹）
  NAS_ROOT: z.string().default('/mnt/nas'),
  // Immich 的数据卷（只读），用来统计缩略图等占了多少空间
  IMMICH_DATA_DIR: z.string().default('/immich-data'),
  // 挂载服务（nas-mounter）的控制 socket；不存在时 NAS 管理功能不可用
  MOUNTER_SOCKET: z.string().default('/run/mounter/mounter.sock'),
  PORT: z.coerce.number().int().default(3000),
  DATA_DIR: z.string().default('./data'),
  // 前端构建产物目录；不存在时只提供 API
  WEB_DIR: z.string().default(resolve(import.meta.dirname, '../../baby-web/dist')),
  // 会话签名密钥；不填时自动生成并保存在 DATA_DIR 中
  SESSION_SECRET: z.string().min(32).optional(),
  // 每日备份数据库到这个目录（例如挂载在 NAS 上的目录）；不填则不备份
  BACKUP_DIR: z.string().optional(),
  // 强制 Cookie 带 Secure 标记。通常不用设：经 HTTPS 访问时会自动加上
  COOKIE_SECURE: z.stringbool().default(false),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('配置错误：\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

mkdirSync(parsed.data.DATA_DIR, { recursive: true });

function loadSessionSecret(dataDir: string) {
  const file = join(dataDir, 'session-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  ...parsed.data,
  IMMICH_URL: parsed.data.IMMICH_URL.replace(/\/$/, ''),
  SESSION_SECRET: parsed.data.SESSION_SECRET ?? loadSessionSecret(parsed.data.DATA_DIR),
};
