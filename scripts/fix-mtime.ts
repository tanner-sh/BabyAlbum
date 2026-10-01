#!/usr/bin/env node
// 按文件名修正文件的修改时间（mtime）。只改修改时间，不改文件内容。
//
// 为什么需要：没有 EXIF 拍摄时间的照片（微信保存的图片、部分截图等），Immich 只能用文件修改时间当拍摄时间。
// 文件被复制、移动过之后，修改时间就变成了复制的时间，照片会排到错误的位置。
// 这类文件的名字里往往带着真实时间：mmexport1707877800000.jpg（毫秒时间戳）、IMG_20240214_103000.jpg 等。
//
// 为什么不通过 Immich 改：Immich 修改日期是在原文件旁写 .xmp 附属文件，外部图库是只读挂载的，写不进去。
//
// 只处理同时满足以下条件的文件：
//   - 照片或视频；JPEG 需要没有 EXIF 拍摄时间（有 EXIF 的 Immich 不看修改时间，不用改）
//   - 文件名里能解析出时间，且和当前修改时间相差超过一天
//
// 用法（默认只预览）：
//   node scripts/fix-mtime.ts <照片根目录>            # 预览
//   node scripts/fix-mtime.ts <照片根目录> --apply    # 执行
// 在 NAS 上用 Docker 运行（注意这里挂载时不能加 :ro）：
//   docker run --rm -v /volume1/photos:/photos -v "$PWD/scripts:/s:ro" node:24-alpine node /s/fix-mtime.ts /photos
// 执行后到 Immich 的外部图库里点“扫描”，Immich 发现修改时间变了会重新读取元数据。

import { open, opendir, stat, utimes } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const MEDIA_EXT = new Set([
  'jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tif', 'tiff',
  'mp4', 'mov', 'm4v', 'avi', 'mkv', '3gp', 'mts', 'm2ts', 'wmv', 'webm',
]);
const EXCLUDES = new Set(['@eaDir', '#recycle', '@Recycle', '.@__thumb', '.Trash', '.Trashes', '.recycle', 'lost+found']);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    apply: { type: 'boolean', default: false },
    // 文件名里的“年月日时分秒”按哪个时区理解
    offset: { type: 'string', default: '+08:00' },
  },
});

const root = positionals[0];
if (!root) {
  console.error('用法：node fix-mtime.ts <照片根目录> [--apply] [--offset +08:00]');
  process.exit(1);
}
const offset = values.offset!;
const offsetMs = (offset.startsWith('-') ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) * 60_000;

/** 从文件名解析拍摄时刻（毫秒时间戳） */
function timeFromFilename(name: string): number | null {
  const plausible = (ms: number) => (ms > Date.UTC(1995, 0, 1) && ms < Date.now() + 86_400_000 ? ms : null);

  const ms = /(?:mmexport|wx_camera_|microMsg\.)(\d{13})/i.exec(name);
  if (ms) return plausible(Number(ms[1]));

  // 20240214_103000、2024-02-14 10.30.00、20240214103000 等
  const full = /(?:^|\D)(20\d{2}|19\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])[-_. T]?([01]\d|2[0-3])[-_.:]?([0-5]\d)[-_.:]?([0-5]\d)(?:\D|$)/.exec(name);
  if (full) {
    const [, y, mo, d, h, mi, s] = full.map(Number);
    return plausible(Date.UTC(y, mo - 1, d, h, mi, s) - offsetMs);
  }
  // 只有日期：按当天中午
  const day = /(?:^|\D)(20\d{2}|19\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:\D|$)/.exec(name);
  if (day) {
    const [, y, mo, d] = day.map(Number);
    return plausible(Date.UTC(y, mo - 1, d, 12) - offsetMs);
  }
  return null;
}

/** JPEG 是否带有 EXIF 拍摄时间（只读文件头） */
async function jpegHasExifDate(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(128 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const data = buf.subarray(0, bytesRead);
    if (data.readUInt16BE(0) !== 0xffd8) return false;
    let pos = 2;
    while (pos + 4 <= data.length && data[pos] === 0xff) {
      const marker = data[pos + 1];
      const len = data.readUInt16BE(pos + 2);
      if (marker === 0xe1 && data.toString('latin1', pos + 4, pos + 10) === 'Exif\0\0') {
        // 粗略判断：APP1 段里有 “YYYY:MM:DD HH:MM:SS” 格式的时间
        return /\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}/.test(data.toString('latin1', pos + 10, pos + 2 + len));
      }
      if (marker === 0xda) return false;
      pos += 2 + len;
    }
    return false;
  } finally {
    await fh.close();
  }
}

const fmt = (ms: number) => new Date(ms + offsetMs).toISOString().slice(0, 16).replace('T', ' ');

type Fix = { path: string; from: number; to: number };
const fixes: Fix[] = [];
let scanned = 0;

async function walk(dir: string) {
  for await (const entry of await opendir(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDES.has(entry.name)) await walk(full);
      continue;
    }
    const ext = extname(entry.name).slice(1).toLowerCase();
    if (!entry.isFile() || !MEDIA_EXT.has(ext) || entry.name.startsWith('._')) continue;
    scanned++;
    const target = timeFromFilename(basename(entry.name));
    if (target === null) continue;
    const s = await stat(full);
    if (Math.abs(s.mtimeMs - target) < 86_400_000) continue;
    if ((ext === 'jpg' || ext === 'jpeg') && (await jpegHasExifDate(full).catch(() => true))) continue;
    fixes.push({ path: full, from: s.mtimeMs, to: target });
  }
}

await walk(root);
console.log(`检查了 ${scanned} 个照片和视频，需要修正修改时间的有 ${fixes.length} 个（时区 ${offset}）`);
for (const f of fixes.slice(0, 20)) console.log(`  ${relative(root, f.path)}\n    ${fmt(f.from)}  →  ${fmt(f.to)}`);
if (fixes.length > 20) console.log(`  …（还有 ${fixes.length - 20} 个）`);

if (!values.apply) {
  if (fixes.length) console.log('\n以上只是预览，没有修改任何文件。确认无误后加 --apply 执行。');
} else {
  let failed = 0;
  for (const f of fixes) {
    try {
      await utimes(f.path, new Date(f.to), new Date(f.to));
    } catch (err) {
      failed++;
      console.error(`  修改失败：${f.path}（${(err as Error).message}）`);
    }
  }
  console.log(`\n已修正 ${fixes.length - failed} 个${failed ? `，失败 ${failed} 个` : ''}。请到 Immich 的外部图库里点“扫描”。`);
}
