// 相册的核心查询：时间线、那年今日、成长墙、按月龄查询。数据全部来自 Immich，这里只做按年龄的组织

import { computeAge, currentMonths, localToday, monthDate, shiftDays } from './age.ts';
import { dateOverrides, hiddenAssets, type Baby } from './db.ts';
import { immich } from './immich.ts';

type Asset = immich.AssetResponseDto;

export type PhotoItem = {
  id: string;
  type: string;
  takenAt: string;
  fileName: string;
  duration: number | null;
  isFavorite: boolean;
  width: number | null;
  height: number | null;
  /** 实况照片的视频部分 */
  livePhotoVideoId: string | null;
};

export type AlbumItem = PhotoItem & { age: { label: string; days: number; months: number } };

export function toPhotoItem(a: Asset): PhotoItem {
  return {
    id: a.id,
    type: a.type,
    takenAt: a.localDateTime,
    fileName: a.originalFileName,
    duration: a.duration,
    isFavorite: a.isFavorite,
    width: a.width,
    height: a.height,
    livePhotoVideoId: a.livePhotoVideoId ?? null,
  };
}

export function toItem(baby: Baby, a: Asset): AlbumItem {
  const age = computeAge(baby.birthday, a.localDateTime);
  return { ...toPhotoItem(a), age: { label: age.label, days: age.days, months: age.months } };
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

/** 给其他模块用的缓存（同一个缓存池，收藏、隐藏等变化时一起清掉） */
export const cachedPhotos = cached;

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

// ---------------------------------------------------------------- 实况照片、隐藏的照片

/** 实况照片的视频一般只有 1.5～3 秒；还没读完拍摄信息的视频不知道时长 */
const LIVE_MAX_MS = 4000;
const stemOf = (path: string) => path.slice(0, path.lastIndexOf('.')).toLowerCase();
const parentDir = (path: string) => path.slice(0, path.lastIndexOf('/'));
const isShortVideo = (a: Asset) => a.type === immich.AssetTypeEnum.Video && (!a.duration || a.duration <= LIVE_MAX_MS);

type FolderIndex = { images: Map<string, string>; motions: Map<string, string> };

/**
 * 一个文件夹里的照片和短视频（按去掉扩展名的文件名索引），用来识别还没配对的实况照片
 * （iPhone 拍的 IMG_1234.HEIC + IMG_1234.MOV）。Immich 读完两边的拍摄信息后会自动配对并隐藏视频；
 * 配对之前视频会被当成单独的短视频，照片也没有实况标记。照片和视频的日期可能不同，不一定在同一页，
 * 所以按文件夹找，而不是只在当前页里找
 */
function folderIndex(dir: string): Promise<FolderIndex> {
  return cached(`folder:${dir}`, 10 * 60_000, async () => {
    const index: FolderIndex = { images: new Map(), motions: new Map() };
    // originalPath 是“包含”匹配，会带上子文件夹，结果里再精确比较；很大的文件夹最多看 5000 个
    for (let page = 1; page <= 5; page++) {
      const { assets } = await immich.searchAssets({ metadataSearchDto: { originalPath: `${dir}/`, size: 1000, page } });
      for (const a of assets.items) {
        if (parentDir(a.originalPath) !== dir) continue;
        if (a.type === immich.AssetTypeEnum.Image) index.images.set(stemOf(a.originalPath), a.id);
        else if (isShortVideo(a) && a.visibility === immich.AssetVisibility.Timeline) index.motions.set(stemOf(a.originalPath), a.id);
      }
      if (!assets.nextPage) break;
    }
    return index;
  });
}

/** 照片对应的实况视频：优先用 Immich 的配对结果，没配对好之前找同一文件夹里的同名短视频 */
export async function liveVideoOf(imageId: string): Promise<string | null> {
  const image = await immich.getAssetInfo({ id: imageId });
  if (image.livePhotoVideoId) return image.livePhotoVideoId;
  if (image.type !== immich.AssetTypeEnum.Image) return null;
  return (await folderIndex(parentDir(image.originalPath))).motions.get(stemOf(image.originalPath)) ?? null;
}

/**
 * 宝宝相册里要显示的：去掉被隐藏的照片、时间线上不可见的（已配对的实况视频等），
 * 还没配对的实况视频也去掉，并把它挂到对应的照片上
 */
export const tidyAssets = (assets: Asset[]) => tidy(assets);

async function tidy(assets: Asset[]): Promise<Asset[]> {
  const hidden = hiddenAssets.ids();
  const visible = assets.filter((a) => !hidden.has(a.id) && a.visibility === immich.AssetVisibility.Timeline);
  // 只看可能涉及实况的：短视频，以及还没有实况视频的照片
  const dirs = [...new Set(visible.filter((a) => isShortVideo(a) || (a.type === immich.AssetTypeEnum.Image && !a.livePhotoVideoId)).map((a) => parentDir(a.originalPath)))];
  const indexes = new Map(await mapLimit(dirs, 6, async (d) => [d, await folderIndex(d).catch(() => null)] as const));
  const result: Asset[] = [];
  for (const a of visible) {
    const index = indexes.get(parentDir(a.originalPath));
    const stem = stemOf(a.originalPath);
    if (index && isShortVideo(a) && index.images.has(stem)) continue;
    const motion = index && a.type === immich.AssetTypeEnum.Image && !a.livePhotoVideoId ? index.motions.get(stem) : undefined;
    result.push(motion ? { ...a, livePhotoVideoId: motion } : a);
  }
  return result;
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
  opts: { size?: number; page?: number; isFavorite?: boolean; order?: immich.AssetOrder; withPeople?: boolean } = {},
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
      page: opts.page,
      visibility: immich.AssetVisibility.Timeline,
      withPeople: opts.withPeople,
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
  const sorted = extra.length ? items.sort(byTakenAt(opts.order === immich.AssetOrder.Desc ? 'desc' : 'asc')) : items;
  return Object.assign(await tidy(sorted), { hasMore: !!assets.nextPage });
}

/** 一段时间内的全部照片（自动翻页），用于回顾挑选 */
async function searchAll(baby: Baby, from: string, to: string, opts: { withPeople?: boolean } = {}) {
  const all: Asset[] = [];
  for (let page = 1; page <= 30; page++) {
    const items = await searchRange(baby, from, to, { ...opts, page });
    all.push(...items);
    if (!items.hasMore) break;
  }
  // 日期更正过的照片每一页都会带上，去重
  return [...new Map(all.map((a) => [a.id, a])).values()];
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
  return { items: await tidy(items), nextPage };
}

/**
 * 时间线：按拍摄时间倒序，按月龄分组。相邻两页可能落在同一个月龄里，前端拼接时合并同名分组即可。
 * withPerson：只看宝宝和某个人物的合照；family：全家福（由 family.ts 算好传进来）
 */
export async function timeline(baby: Baby, page: number, size: number, filter: { withPerson?: string; family?: () => Promise<Asset[]> } = {}) {
  let items: Asset[];
  let nextPage: number | null;
  if (filter.family) {
    const all = await filter.family();
    items = all.slice((page - 1) * size, page * size);
    nextPage = all.length > page * size ? page + 1 : null;
  } else {
    const personIds = filter.withPerson ? [baby.immichPersonId, filter.withPerson] : [baby.immichPersonId];
    ({ items, nextPage } = await pageWithCorrections({ personIds, visibility: immich.AssetVisibility.Timeline }, page, size, async (o) =>
      (await correctedAssetsOf(baby, o)).filter((a) => !filter.withPerson || (a.people ?? []).some((p) => p.id === filter.withPerson)),
    ));
  }
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
    group.items.push(toPhotoItem(a));
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

/** 一段时间内的所有文件（不限人物，自动翻页） */
async function searchBefore(date: string, maxPages = 10) {
  const all: Asset[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { assets } = await immich.searchAssets({
      metadataSearchDto: { takenBefore: `${shiftDays(date, 1)}T00:00:00.000Z`, size: 1000, page, visibility: immich.AssetVisibility.Timeline },
    });
    all.push(...assets.items);
    if (!assets.nextPage) break;
  }
  return all;
}

/** 文件夹（含子文件夹）里有没有这个宝宝的照片 */
function folderHasBaby(baby: Baby, folder: string) {
  return cached(`folder-baby:${baby.immichPersonId}:${folder}`, 10 * 60_000, async () => {
    const { assets } = await immich.searchAssets({ metadataSearchDto: { personIds: [baby.immichPersonId], originalPath: `${folder}/`, size: 20 } });
    return assets.items.some((a) => a.originalPath.startsWith(`${folder}/`));
  });
}

/**
 * 找出日期明显错误的照片和视频：日期在出生之前，却是宝宝的，一定是错的
 * （常见于影楼相册设计页带着模板的旧日期、相机时钟没调、视频没有拍摄时间只能用文件时间）。
 * - 照片：人脸识别出有宝宝
 * - 视频：人脸常常识别不出来，所以只要它所在的文件夹里有宝宝的照片，就算宝宝的
 * 按文件夹分组，用同文件夹里可信照片最集中的那一天作为建议日期；整个文件夹都不可信时往上找一级。
 * 文件夹里有这类问题时，同文件夹中和建议日期相差很远的照片也一并列出（同一批交付的照片日期往往五花八门）；
 * 视频一般带着准确的拍摄时间，只有早于出生才列出。
 */
export async function dateIssues(baby: Baby) {
  const overrides = dateOverrides.all();
  const isWrong = (a: Asset) => !overrides.has(a.id) && a.localDateTime.slice(0, 10) < baby.birthday;
  const { assets } = await immich.searchAssets({
    metadataSearchDto: {
      personIds: [baby.immichPersonId],
      takenBefore: `${shiftDays(baby.birthday, 1)}T00:00:00.000Z`,
      size: 1000,
      visibility: immich.AssetVisibility.Timeline,
    },
  });
  const wrong = new Map(assets.items.filter(isWrong).map((a) => [a.id, a]));

  // 出生前的视频：看所在文件夹里有没有宝宝
  const videos = (await searchBefore(baby.birthday)).filter((a) => a.type === immich.AssetTypeEnum.Video && isWrong(a) && !wrong.has(a.id));
  const videoFolders = [...new Set(videos.map((a) => parentDir(a.originalPath)))];
  const babyFolders = new Set((await mapLimit(videoFolders, 4, async (f) => ((await folderHasBaby(baby, f)) ? f : null))).filter((f) => f !== null));
  for (const v of videos) if (babyFolders.has(parentDir(v.originalPath))) wrong.set(v.id, v);

  const folders = [...new Set([...wrong.values()].map((a) => parentDir(a.originalPath)))];
  const groups = await mapLimit(folders, 4, async (folder) => {
    const inFolder = (await immich.searchAssets({ metadataSearchDto: { originalPath: `${folder}/`, size: 1000, withPeople: true } })).assets.items.filter(
      (a) => !overrides.has(a.id) && parentDir(a.originalPath) === folder && a.visibility === immich.AssetVisibility.Timeline,
    );
    let suggested = dominantDate(inFolder, baby.birthday);
    if (!suggested) {
      const parent = (await immich.searchAssets({ metadataSearchDto: { originalPath: `${parentDir(folder)}/`, size: 1000 } })).assets.items;
      suggested = dominantDate(parent.filter((a) => !overrides.has(a.id) && !a.originalPath.startsWith(`${folder}/`)), baby.birthday);
    }
    // 这个文件夹里宝宝的：有宝宝的照片、已经判定有问题的，以及视频（同一文件夹里，视频大概率也是宝宝的）
    const mine = inFolder.filter(
      (a) => (a.people ?? []).some((p) => p.id === baby.immichPersonId) || wrong.has(a.id) || a.type === immich.AssetTypeEnum.Video,
    );
    const flagged = mine.filter((a) => {
      const d = a.localDateTime.slice(0, 10);
      if (d < baby.birthday) return true;
      // 视频一般带着准确的拍摄时间（入学照文件夹里放几段小时候的视频很正常），只有早于出生才算错
      if (a.type === immich.AssetTypeEnum.Video) return false;
      // 小文件夹（一批交付的照片）里和建议日期相差超过 45 天的，也很可能是同一类问题
      return !!suggested && inFolder.length <= 300 && dayDiff(d, suggested) > 45;
    });
    return {
      folder: folder.split('/').slice(-2).join('/'),
      suggestedDate: suggested,
      items: (await tidy(flagged.sort(byTakenAt('asc')))).map((a) => toItem(baby, a)),
    };
  });
  return groups.filter((g) => g.items.length);
}

// ---------------------------------------------------------------- 某一天的照片（日记用）

export async function dayItems(baby: Baby, date: string) {
  const items = await searchRange(baby, date, shiftDays(date, 1), { size: 300 });
  return items.map((a) => toItem(baby, a));
}

// ---------------------------------------------------------------- 语义搜索

/**
 * 用一句话搜照片（“在海边”“吃蛋糕”），由 Immich 的 CLIP 模型完成。
 * personIds 为 null 时搜全部照片；否则只搜有这些宝宝之一的照片（Immich 的 personIds 是“同时出现”，所以逐个搜再合并）
 */
export async function smartSearch(query: string, personIds: string[] | null, page: number, size: number) {
  const search = (ids?: string[]) =>
    immich
      .searchSmart({ smartSearchDto: { query, personIds: ids, page, size, language: 'zh-CN', visibility: immich.AssetVisibility.Timeline } })
      .catch((err) => {
        // 把照片服务的报错换成能看懂的提示（statusCode < 500 的错误会把 message 返回给前端）
        if (immich.isHttpError(err) && err.status === 400 && /not enabled/i.test(String((err.data as { message?: unknown })?.message))) {
          throw Object.assign(new Error('语义搜索没有开启，管理员可以在“管理 → 系统设置 → 人脸识别与搜索”里打开'), { statusCode: 409 });
        }
        if (immich.isHttpError(err) && err.status >= 500) {
          throw Object.assign(new Error('语义搜索暂时用不了，照片服务的智能功能可能还在启动，请稍后再试'), { statusCode: 409 });
        }
        throw err;
      });
  const results = personIds === null ? [await search()] : await Promise.all(personIds.map((id) => search([id])));
  // 多个宝宝的结果按名次交替合并
  const merged: Asset[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < size; i++) {
    for (const r of results) {
      const a = r.assets.items[i];
      if (a && !seen.has(a.id)) {
        seen.add(a.id);
        merged.push(a);
      }
    }
  }
  const overrides = dateOverrides.all();
  const items = (await tidy(merged)).map((a) => toPhotoItem(corrected(a, overrides)));
  return { page, nextPage: results.some((r) => r.assets.nextPage) ? page + 1 : null, items };
}

// ---------------------------------------------------------------- 自动回顾

export type ReviewKind = 'month' | 'year';

/** 回顾的时间范围：第 index 个月龄（满 index 个月起的一个月），或第 index 年（index 岁这一年） */
export function reviewRange(baby: Baby, kind: ReviewKind, index: number) {
  const months = kind === 'month' ? index : index * 12;
  const span = kind === 'month' ? 1 : 12;
  const from = monthDate(baby.birthday, months);
  const to = monthDate(baby.birthday, months + span);
  const label = kind === 'month' ? (index === 0 ? '第一个月' : `${computeAge(baby.birthday, from).groupLabel}`) : index === 0 ? '出生第一年' : `${index} 岁这一年`;
  return { from, to, label };
}

/** 宝宝的脸在照片里占的比例（越大越像“主角照”） */
async function faceShare(assetId: string, personId: string) {
  const faces = await immich.getFaces({ id: assetId }).catch(() => []);
  const face = faces.find((f) => f.person?.id === personId);
  if (!face || !face.imageWidth || !face.imageHeight) return 0;
  const area = ((face.boundingBoxX2 - face.boundingBoxX1) * (face.boundingBoxY2 - face.boundingBoxY1)) / (face.imageWidth * face.imageHeight);
  return Math.max(0, Math.min(area, 1));
}

/**
 * 从一段时间的照片里挑精选：
 * - 打分：收藏的优先；分辨率高的、同框人数不多的加分；最后对入围的照片看宝宝的脸有多大（越像“主角照”越好）
 * - 连拍去重：前后 90 秒内拍的算同一组，只留分最高的一张
 * - 平均分布：按天（月度）或按月（年度）分桶，轮流从每个桶里取最好的，避免集中在某一天
 * Immich 没有提供清晰度评分，所以没有按清晰度挑
 */
async function pickHighlights(baby: Baby, assets: Asset[], count: number, bucketOf: (a: Asset) => string) {
  const base = (a: Asset) => {
    const megapixels = ((a.width ?? 0) * (a.height ?? 0)) / 1e6;
    const people = a.people?.length ?? 1;
    return (a.isFavorite ? 100 : 0) + Math.min(megapixels, 12) + (people <= 3 ? 5 : 0);
  };
  const images = assets.filter((a) => a.type === immich.AssetTypeEnum.Image).sort(byTakenAt('asc'));

  // 连拍去重
  const bursts: Asset[][] = [];
  for (const a of images) {
    const last = bursts.at(-1);
    if (last && Date.parse(a.localDateTime) - Date.parse(last.at(-1)!.localDateTime) <= 90_000) last.push(a);
    else bursts.push([a]);
  }
  const candidates = bursts.map((b) => b.reduce((best, a) => (base(a) > base(best) ? a : best)));

  /** 分桶轮流取 n 张 */
  const spread = (list: Asset[], n: number, score: (a: Asset) => number) => {
    const buckets = new Map<string, Asset[]>();
    for (const a of list) buckets.set(bucketOf(a), [...(buckets.get(bucketOf(a)) ?? []), a]);
    const queues = [...buckets.values()].map((q) => q.sort((x, y) => score(y) - score(x)));
    queues.sort((x, y) => score(y[0]) - score(x[0]));
    const picked: Asset[] = [];
    while (picked.length < n && queues.some((q) => q.length)) {
      for (const q of queues) {
        const a = q.shift();
        if (a && picked.length < n) picked.push(a);
      }
    }
    return picked;
  };

  // 第一轮粗选 3 倍数量，第二轮查人脸大小后精选
  const shortlist = spread(candidates, count * 3, base);
  const shares = new Map(await mapLimit(shortlist, 6, async (a) => [a.id, await faceShare(a.id, baby.immichPersonId)] as const));
  // 脸占画面 12% 以上的特写不再额外加分
  const full = (a: Asset) => base(a) + Math.min(shares.get(a.id) ?? 0, 0.12) * 250;
  return spread(shortlist, count, full).sort(byTakenAt('asc'));
}

export function review(baby: Baby, kind: ReviewKind, index: number) {
  return cached(`review:${baby.id}:${baby.birthday}:${kind}:${index}:${localToday()}`, 30 * 60_000, async () => {
    const { from, to, label } = reviewRange(baby, kind, index);
    const assets = await searchAll(baby, from, to, { withPeople: true });
    // 照片少的时候只挑四分之一，才算“精选”
    const images = assets.filter((a) => a.type === immich.AssetTypeEnum.Image).length;
    const count = Math.min(kind === 'month' ? 12 : 36, Math.max(kind === 'month' ? 4 : 12, Math.ceil(images / 4)));
    const highlights = await pickHighlights(baby, assets, count, (a) => (kind === 'month' ? a.localDateTime.slice(0, 10) : String(computeAge(baby.birthday, a.localDateTime).months)));
    return {
      kind,
      index,
      label,
      from,
      to,
      total: assets.length,
      videos: assets.filter((a) => a.type === immich.AssetTypeEnum.Video).length,
      favorites: assets.filter((a) => a.isFavorite).length,
      items: highlights.map((a) => toItem(baby, a)),
    };
  });
}
