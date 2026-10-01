#!/usr/bin/env node
// 第 0 阶段：盘点 NAS 上的照片和视频。只读，不修改任何文件，无第三方依赖（Node 24+）。
//
// 用法：
//   node scripts/inventory.ts <照片根目录> [--out report.json] [--exclude 目录名,目录名]
//
// 在 NAS 上用 Docker 运行（不用安装 Node）：
//   docker run --rm -v /volume1/photos:/photos:ro -v "$PWD/scripts:/s" node:24-alpine \
//     node /s/inventory.ts /photos --out /s/inventory-report.json

import { createHash } from 'node:crypto';
import { open, opendir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'jxl']);
const RAW_EXT = new Set(['dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'srw', 'pef']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'avi', 'mkv', '3gp', 'mts', 'm2ts', 'wmv', 'flv', 'webm', 'mpg', 'mpeg']);
// NAS 系统目录与回收站
const DEFAULT_EXCLUDES = ['@eaDir', '#recycle', '@Recycle', '.@__thumb', '.Trash', '.Trashes', '.recycle', 'lost+found', '.stfolder'];
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

type Kind = 'image' | 'raw' | 'video' | 'other';
type DateSource = 'exif' | 'filename' | 'mtime';
type FileInfo = { path: string; ext: string; kind: Kind; size: number; mtime: Date };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    exclude: { type: 'string', default: '' },
    concurrency: { type: 'string', default: '16' },
  },
});

const root = positionals[0];
if (!root) {
  console.error('用法：node inventory.ts <照片根目录> [--out report.json] [--exclude 目录名,目录名]');
  process.exit(1);
}
const excludes = new Set([...DEFAULT_EXCLUDES, ...values.exclude!.split(',').filter(Boolean)]);
const concurrency = Number(values.concurrency);

// ---------------------------------------------------------------- 日期识别

/** 从文件名解析拍摄时间：IMG_20230512_…、VID_…、PXL_…、mmexport1683…（毫秒时间戳）、微信图片_2023… 等 */
function dateFromFilename(name: string): Date | null {
  const ms = /(?:mmexport|wx_camera_|microMsg\.)(\d{13})/i.exec(name);
  if (ms) return validDate(new Date(Number(ms[1])));
  const ymd = /(?:^|[^\d])(20\d{2}|19\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[^\d]|$)/.exec(name);
  if (ymd) return validDate(new Date(`${ymd[1]}-${ymd[2]}-${ymd[3]}T12:00:00`));
  return null;
}

function validDate(d: Date) {
  const y = d.getFullYear();
  return y >= 1990 && y <= new Date().getFullYear() + 1 ? d : null;
}

/** 读取 JPEG 的 EXIF DateTimeOriginal（只读文件头 128KB） */
async function jpegExifDate(path: string): Promise<Date | null> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(128 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return parseJpegExifDate(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

function parseJpegExifDate(buf: Buffer): Date | null {
  if (buf.readUInt16BE(0) !== 0xffd8) return null;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null;
    const marker = buf[pos + 1];
    const len = buf.readUInt16BE(pos + 2);
    if (marker === 0xe1 && buf.toString('latin1', pos + 4, pos + 10) === 'Exif\0\0') {
      return parseTiffDate(buf.subarray(pos + 10, pos + 2 + len));
    }
    if (marker === 0xda) return null; // 已到图像数据
    pos += 2 + len;
  }
  return null;
}

function parseTiffDate(tiff: Buffer): Date | null {
  if (tiff.length < 8) return null;
  const le = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const findTag = (ifd: number, tag: number) => {
    if (ifd + 2 > tiff.length) return null;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > tiff.length) return null;
      if (u16(e) === tag) return e;
    }
    return null;
  };
  const readAscii = (entry: number) => {
    const count = u32(entry + 4);
    const off = count <= 4 ? entry + 8 : u32(entry + 8);
    return off + count <= tiff.length ? tiff.toString('latin1', off, off + count).replace(/\0.*$/, '') : null;
  };

  const ifd0 = u32(4);
  const exifPtr = findTag(ifd0, 0x8769);
  const exifIfd = exifPtr ? u32(exifPtr + 8) : null;
  // 优先 DateTimeOriginal，其次 DateTimeDigitized，最后 IFD0 的 DateTime
  const entry = (exifIfd && (findTag(exifIfd, 0x9003) ?? findTag(exifIfd, 0x9004))) || findTag(ifd0, 0x0132);
  const raw = entry ? readAscii(entry) : null;
  const m = raw && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(raw);
  return m ? validDate(new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`)) : null;
}

// ---------------------------------------------------------------- 扫描

function kindOf(ext: string): Kind {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (RAW_EXT.has(ext)) return 'raw';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'other';
}

const files: FileInfo[] = [];
const junk = { count: 0, bytes: 0 };
let errors = 0;

async function walk(dir: string) {
  let handle;
  try {
    handle = await opendir(dir);
  } catch {
    errors++;
    return;
  }
  for await (const entry of handle) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!excludes.has(entry.name)) await walk(full);
    } else if (entry.isFile()) {
      try {
        const s = await stat(full);
        if (JUNK_FILES.has(entry.name) || entry.name.startsWith('._')) {
          junk.count++;
          junk.bytes += s.size;
          continue;
        }
        const ext = extname(entry.name).slice(1).toLowerCase();
        files.push({ path: full, ext, kind: kindOf(ext), size: s.size, mtime: s.mtime });
      } catch {
        errors++;
      }
    }
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/** 快速指纹：大小 + 头尾各 64KB 的 SHA-1。只用于找出“疑似重复”，不是逐字节比对 */
async function quickHash(f: FileInfo) {
  const fh = await open(f.path, 'r');
  try {
    const chunk = 64 * 1024;
    const h = createHash('sha1').update(String(f.size));
    const head = Buffer.alloc(Math.min(chunk, f.size));
    await fh.read(head, 0, head.length, 0);
    h.update(head);
    if (f.size > chunk * 2) {
      const tail = Buffer.alloc(chunk);
      await fh.read(tail, 0, chunk, f.size - chunk);
      h.update(tail);
    }
    return h.digest('hex');
  } finally {
    await fh.close();
  }
}

const fmtBytes = (n: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
};
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '-');

let phase = '扫描目录';
let done = 0;
const progress = setInterval(() => console.error(`[${phase}] 已处理 ${phase === '扫描目录' ? files.length : done} 个文件…`), 5000);

async function main() {
  const started = Date.now();
  await walk(root);

  // 日期来源
  phase = '识别拍摄日期';
  const media = files.filter((f) => f.kind !== 'other');
  const dateSource: Record<DateSource, number> = { exif: 0, filename: 0, mtime: 0 };
  const noExifByExt: Record<string, number> = {};
  const byYear: Record<string, { count: number; bytes: number }> = {};
  await mapLimit(media, concurrency, async (f) => {
    let date: Date | null = null;
    let source: DateSource = 'mtime';
    if (f.ext === 'jpg' || f.ext === 'jpeg') {
      date = await jpegExifDate(f.path).catch(() => null);
      if (date) source = 'exif';
    }
    if (!date) {
      date = dateFromFilename(basename(f.path));
      if (date) source = 'filename';
    }
    // HEIC、视频等格式的元数据 Immich 能读（exiftool），这里不解析，只统计文件名能否兜底
    if (!date) {
      date = f.mtime;
      if (f.ext === 'jpg' || f.ext === 'jpeg') noExifByExt[f.ext] = (noExifByExt[f.ext] ?? 0) + 1;
    }
    dateSource[source]++;
    const y = String(date.getFullYear());
    byYear[y] ??= { count: 0, bytes: 0 };
    byYear[y].count++;
    byYear[y].bytes += f.size;
    done++;
  });

  // 疑似重复：先按大小分组，大小相同的再算快速指纹
  phase = '查找重复';
  done = 0;
  const bySize = new Map<number, FileInfo[]>();
  for (const f of media) if (f.size > 0) bySize.set(f.size, [...(bySize.get(f.size) ?? []), f]);
  const candidates = [...bySize.values()].filter((g) => g.length > 1).flat();
  const byHash = new Map<string, FileInfo[]>();
  await mapLimit(candidates, concurrency, async (f) => {
    const h = await quickHash(f).catch(() => null);
    if (h) byHash.set(h, [...(byHash.get(h) ?? []), f]);
    done++;
  });
  const dupGroups = [...byHash.values()].filter((g) => g.length > 1);
  const dupExtraFiles = dupGroups.reduce((n, g) => n + g.length - 1, 0);
  const dupExtraBytes = dupGroups.reduce((n, g) => n + (g.length - 1) * g[0].size, 0);

  // Live Photo：同目录同名的图片 + MOV
  const stems = new Map<string, Set<Kind>>();
  for (const f of media) {
    const stem = f.path.slice(0, -f.ext.length - 1).toLowerCase();
    const kinds = stems.get(stem) ?? new Set();
    kinds.add(f.ext === 'mov' ? 'video' : f.kind);
    stems.set(stem, kinds);
  }
  const livePairs = [...stems.values()].filter((k) => k.has('image') && k.has('video')).length;

  // 按扩展名汇总
  const byExt: Record<string, { kind: Kind; count: number; bytes: number }> = {};
  for (const f of files) {
    const key = f.ext || '(无扩展名)';
    byExt[key] ??= { kind: f.kind, count: 0, bytes: 0 };
    byExt[key].count++;
    byExt[key].bytes += f.size;
  }
  const byKind = (k: Kind) => files.filter((f) => f.kind === k).reduce((a, f) => ({ count: a.count + 1, bytes: a.bytes + f.size }), { count: 0, bytes: 0 });
  const kinds = { image: byKind('image'), raw: byKind('raw'), video: byKind('video'), other: byKind('other') };
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const largest = [...media].sort((a, b) => b.size - a.size).slice(0, 10);

  clearInterval(progress);

  // ---------------------------------------------------------------- 输出
  // 中文字符在终端里占两列
  const width = (t: string) => [...t].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const line = (label: string, v: string) => console.log(`  ${label}${' '.repeat(Math.max(1, 16 - width(label)))}${v}`);
  console.log(`\n盘点结果：${root}（耗时 ${((Date.now() - started) / 1000).toFixed(0)} 秒）\n`);
  console.log('总览');
  line('文件总数', `${files.length.toLocaleString()} 个，${fmtBytes(totalBytes)}`);
  line('照片', `${kinds.image.count.toLocaleString()} 个，${fmtBytes(kinds.image.bytes)}`);
  line('RAW', `${kinds.raw.count.toLocaleString()} 个，${fmtBytes(kinds.raw.bytes)}`);
  line('视频', `${kinds.video.count.toLocaleString()} 个，${fmtBytes(kinds.video.bytes)}`);
  line('其他文件', `${kinds.other.count.toLocaleString()} 个，${fmtBytes(kinds.other.bytes)}`);
  line('系统垃圾文件', `${junk.count.toLocaleString()} 个（.DS_Store 等，已忽略）`);
  if (errors) line('无法读取', `${errors} 个（权限或损坏）`);

  console.log('\n拍摄日期来源（照片 + 视频）');
  line('EXIF', `${dateSource.exif.toLocaleString()}（${pct(dateSource.exif, media.length)}，仅统计 JPEG）`);
  line('文件名', `${dateSource.filename.toLocaleString()}（${pct(dateSource.filename, media.length)}）`);
  line('只能用修改时间', `${dateSource.mtime.toLocaleString()}（${pct(dateSource.mtime, media.length)}）`);
  console.log('  注：HEIC、视频的元数据 Immich 能读取，这里只做了文件名兜底，实际“只能用修改时间”的比例会更低');

  console.log('\n按年份（依据上面识别到的日期）');
  for (const [y, v] of Object.entries(byYear).sort()) line(y, `${v.count.toLocaleString().padStart(9)} 个  ${fmtBytes(v.bytes)}`);

  console.log('\n格式分布（前 15）');
  for (const [ext, v] of Object.entries(byExt).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 15)) {
    line(ext, `${v.count.toLocaleString().padStart(9)} 个  ${fmtBytes(v.bytes).padStart(10)}  ${v.kind}`);
  }

  console.log('\n重复与特殊情况');
  line('疑似重复', `${dupGroups.length.toLocaleString()} 组，多余 ${dupExtraFiles.toLocaleString()} 个文件，约 ${fmtBytes(dupExtraBytes)}`);
  line('Live Photo', `${livePairs.toLocaleString()} 对（图片 + 同名 MOV）`);

  console.log('\n缓存空间预估（Immich 缩略图 + 预览图 + 视频转码）');
  const thumbs = (kinds.image.count + kinds.raw.count + kinds.video.count) * 400 * 1024;
  const transcode = kinds.video.bytes * 0.15;
  line('缩略图/预览', `约 ${fmtBytes(thumbs)}（按每个文件约 400KB）`);
  line('视频转码', `约 ${fmtBytes(transcode)}（按视频原始大小的 15%，可在 Immich 中关闭）`);

  if (values.out) {
    const report = {
      root,
      generatedAt: new Date().toISOString(),
      totals: { files: files.length, bytes: totalBytes, ...kinds, junk, errors },
      dateSource,
      byYear,
      byExt,
      duplicates: {
        groups: dupGroups.length,
        extraFiles: dupExtraFiles,
        extraBytes: dupExtraBytes,
        // 只保留前 200 组，完整清单可能非常大
        samples: dupGroups.slice(0, 200).map((g) => ({ size: g[0].size, files: g.map((f) => relative(root, f.path)) })),
      },
      livePhotoPairs: livePairs,
      largest: largest.map((f) => ({ path: relative(root, f.path), bytes: f.size })),
      estimates: { thumbnailBytes: thumbs, transcodeBytes: transcode },
    };
    await writeFile(values.out, JSON.stringify(report, null, 2));
    console.log(`\n完整报告已写入 ${values.out}`);
  }
}

await main();
