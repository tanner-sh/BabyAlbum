// 导入进度：照片、视频各还剩多少没处理，最近的处理速度，预计还要多久。
//
// Immich 的任务队列只有总数，不区分照片和视频，所以：
// - 每分钟记录一次各队列的剩余数量，用最近一段时间的下降速度估算各步骤还要多久
// - 导入期间每 10 分钟逐页统计一次所有文件是否读完了拍摄信息（读完之前 width 为空；API 里的 hasMetadata 恒为 true，不能用），
//   按照片、视频分别计数；
//   照片和视频的剩余时间用相邻两次统计之间的下降速度估算（视频要整个读一遍，比照片慢得多）

import type { FastifyBaseLogger } from 'fastify';
import { settings } from './db.ts';
import { immichConnected } from './immich-link.ts';
import { immich } from './immich.ts';

const SAMPLE_MS = 60_000;
const COUNT_MS = 10 * 60_000;
/** 估算速度用的时间窗口 */
const RATE_WINDOW_MS = 45 * 60_000;
const KEEP_MS = 6 * 3600_000;

/** 导入流水线里会影响“照片出现在相册里”的步骤，按先后顺序 */
const STAGES: { name: immich.QueueName; label: string }[] = [
  { name: immich.QueueName.Library, label: '扫描文件夹' },
  { name: immich.QueueName.Sidecar, label: '读取附属文件' },
  { name: immich.QueueName.MetadataExtraction, label: '读取拍摄信息' },
  { name: immich.QueueName.ThumbnailGeneration, label: '生成缩略图' },
  { name: immich.QueueName.FaceDetection, label: '检测人脸' },
  { name: immich.QueueName.FacialRecognition, label: '识别人物' },
  { name: immich.QueueName.SmartSearch, label: '语义搜索索引' },
  { name: immich.QueueName.DuplicateDetection, label: '查找重复照片' },
];

type Sample = { t: number; remaining: Record<string, number> };
type TypeCount = { total: number; pending: number };
type Count = { t: number; image: TypeCount; video: TypeCount };

const samples: Sample[] = [];
const counts: Count[] = [];
let counting = false;

// 采样记录存在数据库里，重启（比如升级）后不用重新等很久才能算出速度
const STORE_KEY = 'import.progress';
function load() {
  try {
    const saved = JSON.parse(settings.get(STORE_KEY) ?? 'null') as { samples: Sample[]; counts: Count[] } | null;
    const fresh = <T extends { t: number }>(list: T[] = []) => list.filter((x) => x.t >= Date.now() - KEEP_MS);
    samples.push(...fresh(saved?.samples));
    counts.push(...fresh(saved?.counts));
  } catch {
    // 记录损坏就重新开始
  }
}
const save = () => settings.set(STORE_KEY, JSON.stringify({ samples, counts }));

/** 每小时处理多少个：最近一段时间里剩余数量的下降速度。数量在增加（还在扫描新文件）或没变化时返回 null */
function ratePerHour<T>(points: T[], t: (p: T) => number, value: (p: T) => number, windowMs = RATE_WINDOW_MS): number | null {
  if (points.length < 2) return null;
  const last = points.at(-1)!;
  // 窗口内最早的一个点；数据不够一个窗口时用最早的
  const first = points.find((p) => t(last) - t(p) <= windowMs) ?? points[0];
  const hours = (t(last) - t(first)) / 3600_000;
  if (hours < 1 / 30) return null;
  const done = value(first) - value(last);
  return done > 0 ? done / hours : null;
}

const eta = (remaining: number, rate: number | null) => (remaining === 0 ? 0 : rate ? remaining / rate : null);

async function sample(log: FastifyBaseLogger) {
  if (!immichConnected()) return;
  try {
    const queues = await immich.getQueues();
    const remaining: Record<string, number> = {};
    for (const q of queues) remaining[q.name] = q.statistics.active + q.statistics.waiting + q.statistics.delayed;
    samples.push({ t: Date.now(), remaining });
    while (samples.length && samples[0].t < Date.now() - KEEP_MS) samples.shift();
    save();

    const importing = [immich.QueueName.Library, immich.QueueName.Sidecar, immich.QueueName.MetadataExtraction].some((q) => remaining[q] > 0);
    const lastCount = counts.at(-1);
    const due = !lastCount || Date.now() - lastCount.t >= COUNT_MS;
    // 导入期间定期统计；导入完了再统计一次，让数字归零
    if (!counting && due && (importing || (lastCount && lastCount.image.pending + lastCount.video.pending > 0))) void countPending(log);
  } catch (err) {
    log.debug({ err }, '读取任务队列失败');
  }
}

/** 逐页统计还没读完拍摄信息的照片、视频（7 万个文件大约要 30 秒，只在导入期间做） */
async function countPending(log: FastifyBaseLogger) {
  counting = true;
  try {
    const image = { total: 0, pending: 0 };
    const video = { total: 0, pending: 0 };
    for (let page = 1; page <= 1000; page++) {
      const { assets } = await immich.searchAssets({ metadataSearchDto: { page, size: 1000 } });
      for (const a of assets.items) {
        // 实况照片的视频部分（隐藏的）不单独算
        if (a.visibility === immich.AssetVisibility.Hidden) continue;
        const bucket = a.type === immich.AssetTypeEnum.Video ? video : a.type === immich.AssetTypeEnum.Image ? image : null;
        if (!bucket) continue;
        bucket.total++;
        if (a.width === null) bucket.pending++;
      }
      if (!assets.nextPage) break;
    }
    counts.push({ t: Date.now(), image, video });
    while (counts.length && counts[0].t < Date.now() - KEEP_MS) counts.shift();
    save();
  } catch (err) {
    log.warn({ err }, '统计导入进度失败');
  } finally {
    counting = false;
  }
}

export function startImportProgress(log: FastifyBaseLogger) {
  load();
  void sample(log);
  setInterval(() => void sample(log), SAMPLE_MS).unref();
}

export function importProgress() {
  const last = samples.at(-1);
  const stages = STAGES.map((s) => {
    const remaining = last?.remaining[s.name] ?? 0;
    const rate = ratePerHour(samples, (p) => p.t, (p) => p.remaining[s.name] ?? 0);
    return { name: s.name, label: s.label, remaining, ratePerHour: rate, etaHours: eta(remaining, rate) };
  });
  const count = counts.at(-1);
  // 照片、视频的速度用最近两小时内的统计算（10 分钟才统计一次，窗口要长一些）
  const typeRate = (key: 'image' | 'video') => ratePerHour(counts, (c) => c.t, (c) => c[key].pending, 2 * 3600_000);
  const byType = (key: 'image' | 'video') => {
    if (!count) return null;
    const rate = typeRate(key);
    return { ...count[key], ratePerHour: rate, etaHours: eta(count[key].pending, rate) };
  };
  return {
    importing: stages.some((s) => s.remaining > 0),
    // 刚启动时还没有足够的数据估算速度
    sampledMinutes: samples.length ? Math.round((samples.at(-1)!.t - samples[0].t) / 60_000) : 0,
    stages,
    photos: byType('image'),
    videos: byType('video'),
    countedAt: count ? new Date(count.t).toISOString() : null,
    counting,
  };
}
