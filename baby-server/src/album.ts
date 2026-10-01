// 相册的核心查询：时间线、那年今日、成长墙、按月龄查询。数据全部来自 Immich，这里只做按年龄的组织

import { computeAge, currentMonths, localToday, monthDate, shiftDays } from './age.ts';
import { dateOverrides, type Baby } from './db.ts';
import { immich } from './immich.ts';

type Asset = immich.AssetResponseDto;

export type AlbumItem = {
  id: string;
  type: string;
  takenAt: string;
  fileName: string;
  duration: number | null;
  isFavorite: boolean;
  width: number | null;
  height: number | null;
  age: { label: string; days: number; months: number };
};

export function toItem(baby: Baby, a: Asset): AlbumItem {
  const age = computeAge(baby.birthday, a.localDateTime);
  return {
    id: a.id,
    type: a.type,
    takenAt: a.localDateTime,
    fileName: a.originalFileName,
    duration: a.duration,
    isFavorite: a.isFavorite,
    width: a.width,
    height: a.height,
    age: { label: age.label, days: age.days, months: age.months },
  };
}

// ---------------------------------------------------------------- 简单的内存缓存

const cache = new Map<string, { expires: number; value: Promise<unknown> }>();

function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
  const value = fn().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { expires: Date.now() + ttlMs, value });
  return value;
}

/** 收藏状态或宝宝资料变化后调用，让成长墙等缓存重新计算 */
export function clearAlbumCache() {
  cache.clear();
}

// ---------------------------------------------------------------- 日期更正
// 外部图库是只读的，Immich 改不了日期，所以更正记录在宝宝相册自己的数据库里，查询时套用

/** 套用日期更正：返回 localDateTime 被替换后的副本 */
function corrected(a: Asset, overrides: Map<string, string>): Asset {
  const fixed = overrides.get(a.id);
  return fixed ? { ...a, localDateTime: `${fixed}.000Z` } : a;
}

/** 所有被更正过日期的照片（已套用更正） */
function correctedAssets(overrides: Map<string, string>): Promise<Asset[]> {
  return cached('corrected:all', 10 * 60_000, async () => {
    const assets = await mapLimit([...overrides.keys()], 6, (id) => immich.getAssetInfo({ id }).catch(() => null));
    return assets.filter((a): a is Asset => !!a);
  }).then((assets) => assets.map((a) => corrected(a, overrides)));
}

/** 这个宝宝的所有被更正过日期的照片（已套用更正） */
async function correctedAssetsOf(baby: Baby, overrides: Map<string, string>): Promise<Asset[]> {
  return (await correctedAssets(overrides)).filter((a) => (a.people ?? []).some((p) => p.id === baby.immichPersonId));
}

const byTakenAt = (order: 'asc' | 'desc') => (a: Asset, b: Asset) =>
  order === 'asc' ? a.localDateTime.localeCompare(b.localDateTime) : b.localDateTime.localeCompare(a.localDateTime);

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

// ---------------------------------------------------------------- 查询

/**
 * 查询某个本地日期区间 [from, to) 内有宝宝的照片。
 * Immich 的 takenAfter/takenBefore 按 UTC 时刻比较，而这里按拍摄地的本地日期划分，
 * 所以前后各放宽一天，再按 localDateTime 精确过滤。
 */
async function searchRange(
  baby: Baby,
  from: string,
  to: string,
  opts: { size?: number; isFavorite?: boolean; order?: immich.AssetOrder } = {},
) {
  const overrides = dateOverrides.all();
  const { assets } = await immich.searchAssets({
    metadataSearchDto: {
      personIds: [baby.immichPersonId],
      takenAfter: `${shiftDays(from, -1)}T00:00:00.000Z`,
      takenBefore: `${shiftDays(to, 1)}T00:00:00.000Z`,
      isFavorite: opts.isFavorite,
      order: opts.order ?? immich.AssetOrder.Asc,
      size: opts.size ?? 1000,
    },
  });
  const inRange = (a: Asset) => {
    const d = a.localDateTime.slice(0, 10);
    return d >= from && d < to;
  };
  // 被更正过的照片：从 Immich 的结果里去掉，再按更正后的日期加回来
  const extra = overrides.size
    ? (await correctedAssetsOf(baby, overrides)).filter((a) => inRange(a) && (opts.isFavorite === undefined || a.isFavorite === opts.isFavorite))
    : [];
  const items = assets.items.filter((a) => !overrides.has(a.id) && inRange(a)).concat(extra);
  return extra.length ? items.sort(byTakenAt(opts.order === immich.AssetOrder.Desc ? 'desc' : 'asc')) : items;
}

/**
 * 按拍摄时间倒序分页，并套用日期更正：被更正过的照片从 Immich 的原始结果里去掉，
 * 再按更正后的日期插到对应的页里。这一页覆盖的时间范围由 Immich 原始结果的首尾决定
 */
async function pageWithCorrections(
  metadataSearchDto: immich.MetadataSearchDto,
  page: number,
  size: number,
  correctedFor: (overrides: Map<string, string>) => Promise<Asset[]>,
) {
  const overrides = dateOverrides.all();
  const { assets } = await immich.searchAssets({ metadataSearchDto: { ...metadataSearchDto, order: immich.AssetOrder.Desc, page, size } });
  const nextPage = assets.nextPage ? Number(assets.nextPage) : null;
  let items = assets.items;
  // 超出最后一页的空页：更正过的照片已经在前面的页里出现过了
  const pastEnd = page > 1 && assets.items.length === 0;
  if (overrides.size && !pastEnd) {
    const upper = page === 1 ? '9999' : (assets.items[0]?.localDateTime ?? '9999');
    const lower = nextPage === null ? '0000' : (assets.items.at(-1)?.localDateTime ?? '0000');
    const extra = (await correctedFor(overrides)).filter((a) => a.localDateTime > lower && a.localDateTime <= upper);
    items = assets.items.filter((a) => !overrides.has(a.id)).concat(extra).sort(byTakenAt('desc'));
  }
  return { items, nextPage };
}

/** 时间线：按拍摄时间倒序，按月龄分组。相邻两页可能落在同一个月龄里，前端拼接时合并同名分组即可 */
export async function timeline(baby: Baby, page: number, size: number) {
  const { items, nextPage } = await pageWithCorrections({ personIds: [baby.immichPersonId] }, page, size, (o) => correctedAssetsOf(baby, o));
  const groups: { label: string; months: number; items: AlbumItem[] }[] = [];
  for (const asset of items) {
    const age = computeAge(baby.birthday, asset.localDateTime);
    let group = groups.at(-1);
    if (group?.label !== age.groupLabel) {
      group = { label: age.groupLabel, months: age.days < 0 ? -1 : age.months, items: [] };
      groups.push(group);
    }
    group.items.push(toItem(baby, asset));
  }
  return { page, nextPage, groups };
}

export type PhotoItem = Omit<AlbumItem, 'age'>;

/** 全部照片：照片库里的所有照片和视频（不管有没有宝宝），按拍摄时间倒序，按月份分组 */
export async function allPhotos(page: number, size: number) {
  // 只要时间线上可见的（Live Photo 的视频部分是隐藏的，不单独显示）
  const { items, nextPage } = await pageWithCorrections({ visibility: immich.AssetVisibility.Timeline }, page, size, correctedAssets);
  const groups: { label: string; items: PhotoItem[] }[] = [];
  for (const a of items) {
    const [y, m] = a.localDateTime.slice(0, 7).split('-').map(Number);
    const label = `${y}年${m}月`;
    let group = groups.at(-1);
    if (group?.label !== label) {
      group = { label, items: [] };
      groups.push(group);
    }
    group.items.push({
      id: a.id,
      type: a.type,
      takenAt: a.localDateTime,
      fileName: a.originalFileName,
      duration: a.duration,
      isFavorite: a.isFavorite,
      width: a.width,
      height: a.height,
    });
  }
  return { page, nextPage, groups };
}

/** 那年今日：往年同月同日拍的照片，按年份倒序 */
export function onThisDay(baby: Baby, today = localToday()) {
  return cached(`otd:${baby.id}:${today}`, 10 * 60_000, async () => {
    const monthDay = today.slice(5);
    const years: number[] = [];
    for (let y = Number(today.slice(0, 4)) - 1; y >= Number(baby.birthday.slice(0, 4)); y--) years.push(y);

    const results = await mapLimit(years, 4, async (y) => {
      const date = `${y}-${monthDay}`;
      // 2 月 29 日在平年不存在
      if (shiftDays(date, 0) !== date || date < baby.birthday) return null;
      const items = await searchRange(baby, date, shiftDays(date, 1), { size: 200 });
      if (!items.length) return null;
      return {
        year: y,
        yearsAgo: Number(today.slice(0, 4)) - y,
        date,
        ageLabel: computeAge(baby.birthday, date).label,
        items: items.map((a) => toItem(baby, a)),
      };
    });
    return results.filter((r) => r !== null);
  });
}

/** 成长墙：每个月龄选一张代表照片，优先选收藏的，没有收藏就选这个月的第一张照片 */
export function growthWall(baby: Baby) {
  return cached(`growth:${baby.id}:${baby.birthday}:${localToday()}`, 10 * 60_000, async () => {
    const total = currentMonths(baby.birthday);
    const months = Array.from({ length: total + 1 }, (_, m) => m);
    return mapLimit(months, 6, async (m) => {
      const from = monthDate(baby.birthday, m);
      const to = monthDate(baby.birthday, m + 1);
      const favorites = await searchRange(baby, from, to, { isFavorite: true, size: 20 });
      const pickFrom = favorites.length ? favorites : await searchRange(baby, from, to, { size: 50 });
      const cover = pickFrom.find((a) => a.type === immich.AssetTypeEnum.Image) ?? pickFrom[0];
      return {
        months: m,
        label: m === 0 ? '新生儿' : computeAge(baby.birthday, from).groupLabel,
        from,
        cover: cover ? toItem(baby, cover) : null,
      };
    });
  });
}

/** 某个月龄的全部照片，按拍摄时间正序。用于成长墙点进去、同龄对比 */
export async function monthItems(baby: Baby, months: number) {
  const from = monthDate(baby.birthday, months);
  const to = monthDate(baby.birthday, months + 1);
  const items = await searchRange(baby, from, to);
  return { months, from, to, items: items.map((a) => toItem(baby, a)) };
}

/** 照片里是否有这些人物之一（分享链接用来做权限检查） */
export function assetHasPerson(assetId: string, personIds: string[]) {
  return cached(`people:${assetId}`, 30 * 60_000, async () => {
    const asset = await immich.getAssetInfo({ id: assetId });
    return (asset.people ?? []).map((p) => p.id);
  }).then((ids) => ids.some((id) => personIds.includes(id)));
}

// ---------------------------------------------------------------- 日期问题检测

const parentDir = (path: string) => path.slice(0, path.lastIndexOf('/'));
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 86_400_000;

/**
 * 一组照片里出现次数最多的日期（只看出生之后的）。
 * 出生之后的照片不到一半时，说明这批照片的日期整体不可信（比如整个文件夹都是设计页），返回 null
 */
function dominantDate(assets: Asset[], birthday: string): string | null {
  const counts = new Map<string, number>();
  let valid = 0;
  for (const a of assets) {
    const d = a.localDateTime.slice(0, 10);
    if (d < birthday) continue;
    valid++;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  if (valid * 2 < assets.length) return null;
  return [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
}

/**
 * 找出日期明显错误的照片：照片里有宝宝，日期却在出生之前，一定是错的
 * （常见于影楼相册设计页带着模板的旧日期、相机时钟没调）。
 * 按文件夹分组，用同文件夹里可信照片最集中的那一天作为建议日期；整个文件夹都不可信时往上找一级。
 * 文件夹里有这类问题时，同文件夹中和建议日期相差很远的照片也一并列出（同一批设计页的日期往往五花八门）。
 */
export async function dateIssues(baby: Baby) {
  const overrides = dateOverrides.all();
  const { assets } = await immich.searchAssets({
    metadataSearchDto: {
      personIds: [baby.immichPersonId],
      takenBefore: `${shiftDays(baby.birthday, 1)}T00:00:00.000Z`,
      size: 1000,
    },
  });
  const wrong = assets.items.filter((a) => !overrides.has(a.id) && a.localDateTime.slice(0, 10) < baby.birthday);

  const folders = [...new Set(wrong.map((a) => parentDir(a.originalPath)))];
  const groups = await mapLimit(folders, 4, async (folder) => {
    const inFolder = (await immich.searchAssets({ metadataSearchDto: { originalPath: `${folder}/`, size: 1000, withPeople: true } })).assets.items.filter(
      (a) => !overrides.has(a.id),
    );
    let suggested = dominantDate(inFolder, baby.birthday);
    if (!suggested) {
      const parent = (await immich.searchAssets({ metadataSearchDto: { originalPath: `${parentDir(folder)}/`, size: 1000 } })).assets.items;
      suggested = dominantDate(parent.filter((a) => !overrides.has(a.id) && !a.originalPath.startsWith(`${folder}/`)), baby.birthday);
    }
    const mine = inFolder.filter((a) => (a.people ?? []).some((p) => p.id === baby.immichPersonId) || wrong.some((w) => w.id === a.id));
    const flagged = mine.filter((a) => {
      const d = a.localDateTime.slice(0, 10);
      if (d < baby.birthday) return true;
      // 小文件夹（一批交付的照片）里和建议日期相差超过 45 天的，也很可能是同一类问题
      return !!suggested && inFolder.length <= 300 && dayDiff(d, suggested) > 45;
    });
    return {
      folder: folder.split('/').slice(-2).join('/'),
      suggestedDate: suggested,
      items: flagged.sort(byTakenAt('asc')).map((a) => toItem(baby, a)),
    };
  });
  return groups.filter((g) => g.items.length);
}
