// 地图：按拍摄地点看照片。坐标来自照片的 GPS（Immich 读拍摄信息时记录），地名来自 Immich 的反向地理编码

import { createRequire } from 'node:module';
import countries from 'i18n-iso-countries';
import { cachedPhotos, tidyAssets, toItem, toPhotoItem } from './album.ts';
import { dateOverrides, hiddenAssets, settings, type Baby } from './db.ts';
import { immich } from './immich.ts';

// ---------------------------------------------------------------- 地名翻译
// Immich 的地名是英文：国家用 i18n-iso-countries 的英文名（这个库自带中文，直接换），
// 中国的省份用下面的对照表；城市（区县）没有可靠的对照数据，保留拼音

const require = createRequire(import.meta.url);
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));
countries.registerLocale(require('i18n-iso-countries/langs/zh.json'));

const PROVINCES: Record<string, string> = {
  Beijing: '北京', Tianjin: '天津', Shanghai: '上海', Chongqing: '重庆', Hebei: '河北', Shanxi: '山西', 'Inner Mongolia': '内蒙古',
  Liaoning: '辽宁', Jilin: '吉林', Heilongjiang: '黑龙江', Jiangsu: '江苏', Zhejiang: '浙江', Anhui: '安徽', Fujian: '福建', Jiangxi: '江西',
  Shandong: '山东', Henan: '河南', Hubei: '湖北', Hunan: '湖南', Guangdong: '广东', Guangxi: '广西', Hainan: '海南', Sichuan: '四川',
  Guizhou: '贵州', Yunnan: '云南', Tibet: '西藏', Shaanxi: '陕西', Gansu: '甘肃', Qinghai: '青海', Ningxia: '宁夏', Xinjiang: '新疆',
  Taipei: '台北', Takao: '高雄', Taiwan: '台湾',
};

const countryZh = (name: string | null) => (name && countries.getName(countries.getAlpha2Code(name, 'en') ?? '', 'zh')) || name;
const stateZh = (name: string | null) => (name && PROVINCES[name]) || name;

export type MapTiles = 'osm' | 'amap';
export const mapTiles = (): MapTiles => (settings.get('map.tiles') === 'amap' ? 'amap' : 'osm');

/** 所有带 GPS 的照片（Immich 只返回时间线上可见的） */
function allMarkers() {
  return cachedPhotos('map:all', 10 * 60_000, () => immich.getMapMarkers({ isArchived: false }));
}

/** 宝宝的所有照片 ID（地图接口不能按人物筛选，自己求交集） */
function babyAssetIds(baby: Baby) {
  return cachedPhotos(`map:baby:${baby.immichPersonId}`, 10 * 60_000, async () => {
    const ids = new Set<string>();
    for (let page = 1; page <= 100; page++) {
      const { assets } = await immich.searchAssets({ metadataSearchDto: { personIds: [baby.immichPersonId], size: 1000, page, visibility: immich.AssetVisibility.Timeline } });
      for (const a of assets.items) ids.add(a.id);
      if (!assets.nextPage) break;
    }
    return ids;
  });
}

const round = (n: number) => Math.round(n * 1e5) / 1e5;

/**
 * 地图上的点和地点列表。babies 为 null 时是全部照片，否则只要有这些宝宝之一的照片。
 * 点用 [id, 纬度, 经度] 的数组表示，几万个点也只有几 MB
 */
export async function mapData(babies: Baby[] | null) {
  const [markers, scope] = await Promise.all([
    allMarkers(),
    babies === null ? null : Promise.all(babies.map(babyAssetIds)).then((sets) => new Set(sets.flatMap((s) => [...s]))),
  ]);
  const hidden = hiddenAssets.ids();
  const visible = markers.filter((m) => !hidden.has(m.id) && (!scope || scope.has(m.id)) && (m.lat || m.lon));

  // 按城市汇总，地点列表用；位置取这个城市所有照片的中心
  const places = new Map<string, { name: string; region: string; count: number; lat: number; lon: number }>();
  for (const m of visible) {
    const state = stateZh(m.state);
    const country = countryZh(m.country);
    const name = m.city ?? state ?? country;
    if (!name) continue;
    const key = [m.country, m.state, m.city].join('|');
    const p = places.get(key) ?? { name, region: [state, country].filter((x) => x && x !== name).join('，'), count: 0, lat: 0, lon: 0 };
    p.count++;
    p.lat += m.lat;
    p.lon += m.lon;
    places.set(key, p);
  }
  return {
    tiles: mapTiles(),
    markers: visible.map((m) => [m.id, round(m.lat), round(m.lon)] as const),
    places: [...places.values()]
      .map((p) => ({ ...p, lat: round(p.lat / p.count), lon: round(p.lon / p.count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 100),
  };
}

/** 地图上选中的一批照片的详细信息（按拍摄时间倒序）。baby 不为空时带上宝宝的年龄 */
export async function mapItems(ids: string[], baby: Baby | null) {
  const overrides = dateOverrides.all();
  const assets = (await Promise.all(ids.map((id) => cachedPhotos(`asset:${id}`, 10 * 60_000, () => immich.getAssetInfo({ id })).catch(() => null)))).filter(
    (a): a is immich.AssetResponseDto => !!a,
  );
  const items = (await tidyAssets(assets)).map((a) => {
    const fixed = overrides.get(a.id);
    return fixed ? { ...a, localDateTime: `${fixed}.000Z` } : a;
  });
  items.sort((a, b) => b.localDateTime.localeCompare(a.localDateTime));
  return items.map((a) => (baby ? toItem(baby, a) : toPhotoItem(a)));
}
