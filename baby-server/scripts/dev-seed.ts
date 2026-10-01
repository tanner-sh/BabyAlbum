// 本机测试环境一键初始化（可重复执行）。宝宝相册启动后会自动初始化 Immich，这里只需要：
//   1. 在宝宝相册里创建管理员（或登录）
//   2. 通过管理接口添加照片库并扫描、关闭机器学习（测试图片里没有真实人脸）
//   3. 直接调用 Immich 创建人物、按文件名前缀手动标注人脸（只有测试需要，正式环境由人脸识别完成）
//   4. 在宝宝相册里添加宝宝
//
//   node scripts/dev-seed.ts

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import * as immich from '@immich/sdk';

const BASE = process.env.BABY_URL ?? 'http://localhost:3000';
const IMMICH_URL = process.env.IMMICH_URL ?? 'http://localhost:2283';
const CRED_FILE = new URL('../../dev-data/dev-credentials.json', import.meta.url);

const BABIES = [
  { prefix: 'xb', name: '小宝', birthday: '2023-06-10' },
  { prefix: 'eb', name: '二宝', birthday: '2025-02-20' },
];

type Creds = { username: string; password: string; displayName: string };
const creds: Creds = existsSync(CRED_FILE)
  ? JSON.parse(readFileSync(CRED_FILE, 'utf8'))
  : { username: 'admin', password: randomBytes(9).toString('base64url'), displayName: '爸爸' };

let cookie = '';
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const data = res.status === 204 ? undefined : await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}

async function waitForImmich() {
  process.stdout.write('等待宝宝相册连接 Immich');
  for (let i = 0; i < 120; i++) {
    const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
    if (health?.immich === 'connected') return console.log(' 完成');
    process.stdout.write('.');
    await sleep(2000);
  }
  throw new Error('宝宝相册没有连上 Immich');
}

async function loginOrSetup() {
  const { needsSetup } = await api<{ needsSetup: boolean }>('GET', '/api/setup');
  if (needsSetup) {
    await api('POST', '/api/setup', creds);
    writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2));
    console.log(`已创建管理员 ${creds.username}`);
  } else {
    await api('POST', '/api/auth/login', { username: creds.username, password: creds.password });
  }
}

type AdminImmich = { libraries: { id: string; importPaths: string[] }[]; queues: { label: string; active: number; waiting: number }[] };

async function waitForJobs() {
  process.stdout.write('等待 Immich 处理任务');
  let idle = 0;
  const deadline = Date.now() + 15 * 60_000;
  while (idle < 3) {
    if (Date.now() > deadline) throw new Error('等待 Immich 任务超时（15 分钟）');
    await sleep(2000);
    const { queues } = await api<AdminImmich>('GET', '/api/admin/immich');
    idle = queues.some((q) => q.active + q.waiting > 0) ? 0 : idle + 1;
    process.stdout.write('.');
  }
  console.log(' 完成');
}

/** 测试脚本需要直接调用 Immich（手动标注人脸），从宝宝相册的数据库里读出它自动创建的密钥 */
function immichKeyFromContainer() {
  const js = `const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('/data/baby.db').prepare("SELECT value FROM settings WHERE key='immich.apiKey'").get().value)`;
  const root = new URL('../../', import.meta.url).pathname;
  return execFileSync('docker', ['compose', 'exec', '-T', 'baby-server', 'node', '--disable-warning=ExperimentalWarning', '-e', js], { cwd: root }).toString().trim();
}

await waitForImmich();
await loginOrSetup();

await api('PUT', '/api/admin/immich/settings', { machineLearning: false });
const { libraries } = await api<AdminImmich>('GET', '/api/admin/immich');
if (!libraries.some((l) => l.importPaths.includes('/mnt/nas/测试照片'))) {
  await api('POST', '/api/admin/libraries', { name: '测试照片', importPaths: ['/mnt/nas/测试照片'] });
  console.log('已添加照片库并开始扫描');
}
await waitForJobs();

immich.init({ baseUrl: `${IMMICH_URL}/api`, apiKey: immichKeyFromContainer() });
const assets: immich.AssetResponseDto[] = [];
for (let page: number | null = 1; page; ) {
  const res = await immich.searchAssets({ metadataSearchDto: { page, size: 1000, withPeople: true } });
  assets.push(...res.assets.items);
  page = res.assets.nextPage ? Number(res.assets.nextPage) : null;
}
console.log(`照片库中共有 ${assets.length} 个文件`);

const existingBabies = await api<{ name: string }[]>('GET', '/api/babies');
const { people } = await immich.getAllPeople({ withHidden: true, size: 500 });
for (const baby of BABIES) {
  const person = people.find((p) => p.name === baby.name) ?? (await immich.createPerson({ personCreateDto: { name: baby.name, birthDate: baby.birthday } }));
  const mine = assets.filter((a) => a.originalFileName.startsWith(`${baby.prefix}_`) || a.originalFileName.startsWith('both_'));
  let tagged = 0;
  for (const asset of mine) {
    if (asset.people?.some((p) => p.id === person.id)) continue;
    const w = asset.width ?? 1600;
    const h = asset.height ?? 1200;
    const left = asset.originalFileName.startsWith('both_') && baby.prefix === 'eb' ? 0.55 : 0.2;
    await immich.createFace({
      assetFaceCreateDto: { assetId: asset.id, personId: person.id, imageWidth: w, imageHeight: h, x: Math.round(w * left), y: Math.round(h * 0.25), width: Math.round(w * 0.25), height: Math.round(h * 0.3) },
    });
    tagged++;
  }
  const cover = mine.find((a) => a.type === immich.AssetTypeEnum.Image && a.originalFileName.startsWith(`${baby.prefix}_`));
  if (cover) await immich.updatePerson({ id: person.id, personUpdateDto: { featureFaceAssetId: cover.id } });
  if (!existingBabies.some((b) => b.name === baby.name)) await api('POST', '/api/babies', { name: baby.name, immichPersonId: person.id, birthday: baby.birthday });
  console.log(`${baby.name}：新标注 ${tagged} 张（共 ${mine.length} 张）`);
}

// 两位没命名的“家人”（测试“认识家里人”、和家人的合照、全家福）：
//   家人 A：每 3 张小宝的照片、全部 family_ 照片、全部 both_ 照片
//   家人 B：每 5 张小宝的照片、全部 both_ 照片
// 每 15 张小宝的照片里有一张同时有小宝、A、B（全家福）
const FAMILY_FILE = new URL('../../dev-data/dev-family.json', import.meta.url);
const familyIds: string[] = existsSync(FAMILY_FILE) ? JSON.parse(readFileSync(FAMILY_FILE, 'utf8')) : [];
const xb = assets.filter((a) => a.originalFileName.startsWith('xb_')).sort((a, b) => a.originalFileName.localeCompare(b.originalFileName));
const FAMILY = [
  { left: 0.6, pick: (a: immich.AssetResponseDto) => a.originalFileName.startsWith('family_') || a.originalFileName.startsWith('both_') || xb.indexOf(a) % 3 === 0 },
  { left: 0.05, pick: (a: immich.AssetResponseDto) => a.originalFileName.startsWith('both_') || xb.indexOf(a) % 5 === 0 },
];
for (const [i, f] of FAMILY.entries()) {
  const person = people.find((p) => p.id === familyIds[i]) ?? (await immich.createPerson({ personCreateDto: {} }));
  familyIds[i] = person.id;
  let tagged = 0;
  for (const asset of assets.filter(f.pick)) {
    if (asset.people?.some((p) => p.id === person.id)) continue;
    const w = asset.width ?? 1600;
    const h = asset.height ?? 1200;
    await immich.createFace({
      assetFaceCreateDto: { assetId: asset.id, personId: person.id, imageWidth: w, imageHeight: h, x: Math.round(w * f.left), y: Math.round(h * 0.1), width: Math.round(w * 0.2), height: Math.round(h * 0.25) },
    });
    tagged++;
  }
  const cover = assets.find((a) => f.pick(a) && a.type === immich.AssetTypeEnum.Image);
  if (cover) await immich.updatePerson({ id: person.id, personUpdateDto: { featureFaceAssetId: cover.id } });
  console.log(`家人 ${'AB'[i]}（未命名）：新标注 ${tagged} 张`);
}
writeFileSync(FAMILY_FILE, JSON.stringify(familyIds));

// 随机收藏一些，用于“成长墙”优先展示收藏
for (const a of assets.filter((a, i) => i % 9 === 0 && !a.isFavorite && a.originalFileName.startsWith('xb_'))) {
  await immich.updateAsset({ id: a.id, updateAssetDto: { isFavorite: true } });
}
await waitForJobs();
console.log(`\n完成。宝宝相册：${BASE}  账号：${creds.username}  密码：${creds.password}`);
