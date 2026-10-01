// 本机测试环境：重新扫描照片库，等 Immich 处理完（scripts/dev-fixtures.sh 写入测试数据后调用）
//   node scripts/dev-rescan.ts

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.BABY_URL ?? 'http://localhost:3000';
const creds = JSON.parse(readFileSync(new URL('../../dev-data/dev-credentials.json', import.meta.url), 'utf8'));

let cookie = '';
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const data = res.status === 204 ? undefined : await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}

type AdminImmich = { libraries: { id: string }[]; queues: { active: number; waiting: number }[] };

await api('POST', '/api/auth/login', { username: creds.username, password: creds.password });
const { libraries } = await api<AdminImmich>('GET', '/api/admin/immich');
for (const l of libraries) await api('POST', `/api/admin/libraries/${l.id}/scan`);

process.stdout.write('等待 Immich 处理任务');
let idle = 0;
const deadline = Date.now() + 15 * 60_000;
// 扫描要过一会儿才会把任务排进队列，先等一下
await sleep(5000);
while (idle < 3) {
  if (Date.now() > deadline) throw new Error('等待 Immich 任务超时（15 分钟）');
  await sleep(2000);
  const { queues } = await api<AdminImmich>('GET', '/api/admin/immich');
  idle = queues.some((q) => q.active + q.waiting > 0) ? 0 : idle + 1;
  process.stdout.write('.');
}
console.log(' 完成');
