// 地图：按拍摄地点看照片。坐标来自照片的 GPS（Immich 读拍摄信息时记录），地名来自 Immich 的反向地理编码

import { cachedPhotos, tidyAssets, toItem, toPhotoItem } from './album.ts';
import { dateOverrides, hiddenAssets, settings, type Baby } from './db.ts';
import { cityZh, countryZh, stateZh } from './geo.ts';
import { immich } from './immich.ts';

// 底图：OpenStreetMap（默认）、高德（非官方的瓦片地址，不需要 Key）、天地图（官方，需要在天地图官网申请浏览器端 Key）
export const MAP_TILES = ['osm', 'amap', 'tianditu'] as const;
export type MapTiles = (typeof MAP_TILES)[number];
export const mapTiles = (): MapTiles => {
  const value = settings.get('map.tiles');
  // 选了天地图但 Key 被清掉了，退回默认
  if (value === 'tianditu') return tiandituKey() ? 'tianditu' : 'osm';
  return value === 'amap' ? 'amap' : 'osm';
};
/** 天地图的浏览器端 Key：在浏览器里加载瓦片时要带上，所以会发给看地图的人（天地图控制台可以限制只允许本站域名使用） */
export const tiandituKey = () => settings.get('map.tiandituKey') ?? null;

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

  // 按城市汇总，地点列表用；位置取这个城市所有照片的中心，中文名按中心位置找（同名的地方很多）
  const groups = new Map<string, { city: string | null; state: string | null; country: string | null; count: number; lat: number; lon: number }>();
  for (const m of visible) {
    if (!m.city && !m.state && !m.country) continue;
    const key = [m.country, m.state, m.city].join('|');
    const g = groups.get(key) ?? { city: m.city, state: m.state, country: m.country, count: 0, lat: 0, lon: 0 };
    g.count++;
    g.lat += m.lat;
    g.lon += m.lon;
    groups.set(key, g);
  }
  const places = [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 100)
    .map((g) => {
      const lat = g.lat / g.count;
      const lon = g.lon / g.count;
      const state = stateZh(g.state, g.country);
      const country = countryZh(g.country);
      const name = cityZh(g.city, g.country, lat, lon) ?? state ?? country ?? '';
      return { name, region: [state, country].filter((x) => x && x !== name).join('，'), count: g.count, lat: round(lat), lon: round(lon) };
    });
  const tiles = mapTiles();
  return {
    tiles,
    tiandituKey: tiles === 'tianditu' ? tiandituKey() : null,
    markers: visible.map((m) => [m.id, round(m.lat), round(m.lon)] as const),
    places,
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
