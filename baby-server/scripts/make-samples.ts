// 生成本机测试用的照片和视频（需要 ffmpeg），模拟 NAS 上的目录。
// 文件名前缀标明画面里是谁（xb = 小宝，eb = 二宝，both = 两人，family = 没有宝宝），
// dev-seed.ts 会按前缀在 Immich 里手动标注人脸，因为生成的图片里没有真实人脸。
//
//   node scripts/make-samples.ts ../dev-data/sample-photos

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

export const BABIES = [
  { prefix: 'xb', name: '小宝', birthday: '2023-06-10' },
  { prefix: 'eb', name: '二宝', birthday: '2025-02-20' },
] as const;

const out = process.argv[2] ?? '../dev-data/sample-photos';
const today = new Date();

// 固定种子的伪随机数，保证每次生成的结果一样
let seed = 20230610;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());

const PALETTE: Record<string, string[]> = {
  xb: ['7fb3d5', 'aed6f1', '5dade2', 'a3e4d7'],
  eb: ['f5b7b1', 'fad7a0', 'f1948a', 'f8c471'],
  both: ['d2b4de', 'bb8fce', 'f9e79f'],
  family: ['a9dfbf', 'd5dbdb', 'abebc6'],
};

/** 构造只含拍摄时间的最小 EXIF（APP1）段 */
function exifSegment(date: Date) {
  const dt = `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}\0`;
  const tiff = Buffer.alloc(116);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  // IFD0：一个条目，指向 Exif IFD
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8769, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  // Exif IFD：DateTimeOriginal、CreateDate、OffsetTimeOriginal
  const entries: [number, number, number][] = [
    [0x9003, 20, 68],
    [0x9004, 20, 88],
    [0x9011, 7, 108],
  ];
  tiff.writeUInt16LE(entries.length, 26);
  entries.forEach(([tag, count, offset], i) => {
    const e = 28 + i * 12;
    tiff.writeUInt16LE(tag, e);
    tiff.writeUInt16LE(2, e + 2); // ASCII
    tiff.writeUInt32LE(count, e + 4);
    tiff.writeUInt32LE(offset, e + 8);
  });
  tiff.writeUInt32LE(0, 28 + entries.length * 12);
  tiff.write(dt, 68, 'latin1');
  tiff.write(dt, 88, 'latin1');
  tiff.write('+08:00\0', 108, 'latin1');
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(2 + 6 + tiff.length, 2);
  return Buffer.concat([header, Buffer.from('Exif\0\0', 'latin1'), tiff]);
}

function makeImage(path: string, who: string, date: Date | null, landscape = rand() > 0.3) {
  const [w, h] = landscape ? [1600, 1200] : [1200, 1600];
  const c0 = pick(PALETTE[who]);
  const c1 = pick(PALETTE[who]);
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', `gradients=s=${w}x${h}:c0=0x${c0}:c1=0x${c1}:c2=0xffffff:n=3:seed=${Math.floor(rand() * 1e6)}:d=1`,
    '-frames:v', '1', '-q:v', '4', path,
  ]);
  if (date) {
    const jpg = readFileSync(path);
    writeFileSync(path, Buffer.concat([jpg.subarray(0, 2), exifSegment(date), jpg.subarray(2)]));
  }
  const mtime = date ?? new Date();
  utimesSync(path, mtime, mtime);
}

function makeVideo(path: string, who: string, date: Date) {
  const c0 = pick(PALETTE[who]);
  const c1 = pick(PALETTE[who]);
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', `gradients=s=1280x720:c0=0x${c0}:c1=0x${c1}:speed=0.05:d=4:r=24`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-metadata', `creation_time=${date.toISOString()}`, path,
  ]);
  utimesSync(path, date, date);
}

type Shot = { who: string; date: Date; video?: boolean };

function plan(): Shot[] {
  const shots: Shot[] = [];
  const at = (s: string) => new Date(`${s}T00:00:00`);
  const withTime = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8 + Math.floor(rand() * 12), Math.floor(rand() * 60));

  // 小宝：出生头一个月拍得最多，之后逐渐变少
  for (let d = at('2023-06-10'); d <= today; ) {
    const ageDays = (d.getTime() - at('2023-06-10').getTime()) / 86_400_000;
    shots.push({ who: 'xb', date: withTime(d), video: rand() < 0.06 });
    d = addDays(d, ageDays < 30 ? 2 : ageDays < 365 ? 7 : 12);
  }
  // 二宝
  for (let d = at('2025-02-20'); d <= today; ) {
    const ageDays = (d.getTime() - at('2025-02-20').getTime()) / 86_400_000;
    shots.push({ who: 'eb', date: withTime(d), video: rand() < 0.06 });
    d = addDays(d, ageDays < 30 ? 2 : 6);
  }
  // 两个宝宝的合照
  for (let d = at('2025-03-01'); d <= today; d = addDays(d, 20)) shots.push({ who: 'both', date: withTime(d) });
  // 没有宝宝的家庭照片（包括小宝出生前）
  for (let d = at('2023-01-15'); d <= today; d = addDays(d, 45)) shots.push({ who: 'family', date: withTime(d) });
  // 那年今日：往年的今天各拍几张
  for (let y = 2024; y < today.getFullYear(); y++) {
    const d = new Date(y, today.getMonth(), today.getDate());
    for (let i = 0; i < 3; i++) shots.push({ who: y >= 2025 && i === 2 ? 'eb' : 'xb', date: withTime(d) });
  }
  return shots;
}

mkdirSync(out, { recursive: true });
if (existsSync(join(out, '.generated'))) {
  console.log(`${out} 已生成过，跳过（删除该目录可重新生成）`);
  process.exit(0);
}

const shots = plan();
let n = 0;
for (const s of shots) {
  // 模拟常见的 NAS 目录：按年/月整理
  const dir = join(out, String(s.date.getFullYear()), `${s.date.getFullYear()}-${pad(s.date.getMonth() + 1)}`);
  mkdirSync(dir, { recursive: true });
  const stamp = `${ymd(s.date).replaceAll('-', '')}_${pad(s.date.getHours())}${pad(s.date.getMinutes())}${pad(n % 60)}`;
  if (s.video) makeVideo(join(dir, `${s.who}_VID_${stamp}.mp4`), s.who, s.date);
  else makeImage(join(dir, `${s.who}_IMG_${stamp}.jpg`), s.who, s.date);
  if (++n % 50 === 0) console.log(`已生成 ${n}/${shots.length}`);
}

// 特殊情况：微信保存的图片（没有 EXIF，时间只在文件名里）、重复文件、系统垃圾文件
const wechat = join(out, '手机备份', '微信');
mkdirSync(wechat, { recursive: true });
for (const s of ['2024-02-14T10:30:00+08:00', '2025-06-01T15:00:00+08:00']) {
  makeImage(join(wechat, `xb_mmexport${new Date(s).getTime()}.jpg`), 'xb', null);
}
const firstPhoto = join(out, '2023', '2023-06');
const dupSource = execFileSync('ls', [firstPhoto]).toString().split('\n').find((f) => f.endsWith('.jpg'))!;
copyFileSync(join(firstPhoto, dupSource), join(out, '手机备份', dupSource));
writeFileSync(join(out, '2024', '.DS_Store'), 'junk');

writeFileSync(join(out, '.generated'), new Date().toISOString());
console.log(`完成：${shots.length + 3} 个文件，位于 ${out}`);
