// 地名翻译成中文。Immich 的反向地理编码用的是 GeoNames 的英文地名，这里对照 GeoNames 的中文名：
// - 国家：Immich 用 i18n-iso-countries 的英文国名，这个库自带中文，直接换
// - 省、州：geo-zh.json 的一级行政区对照（中国的省份用更简短的说法）
// - 城市（区、县、镇）：同名的地方很多（黄浦、黄埔、黄圃），按坐标找最近的那个
// 对照数据由 scripts/geo-names.py 从 GeoNames（CC BY 4.0）生成。找不到中文名的保留原文

import { createRequire } from 'node:module';
import countries from 'i18n-iso-countries';

const require = createRequire(import.meta.url);
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));
countries.registerLocale(require('i18n-iso-countries/langs/zh.json'));

type CityRow = [lat: number, lon: number, country: string, zh: string];
const data = require('./geo-zh.json') as { cities: Record<string, CityRow[]>; admin1: Record<string, string> };

// 中国的省级行政区用简短的说法（“上海”而不是“上海市”）
const PROVINCES: Record<string, string> = {
  Beijing: '北京', Tianjin: '天津', Shanghai: '上海', Chongqing: '重庆', Hebei: '河北', Shanxi: '山西', 'Inner Mongolia': '内蒙古',
  Liaoning: '辽宁', Jilin: '吉林', Heilongjiang: '黑龙江', Jiangsu: '江苏', Zhejiang: '浙江', Anhui: '安徽', Fujian: '福建', Jiangxi: '江西',
  Shandong: '山东', Henan: '河南', Hubei: '湖北', Hunan: '湖南', Guangdong: '广东', Guangxi: '广西', Hainan: '海南', Sichuan: '四川',
  Guizhou: '贵州', Yunnan: '云南', Tibet: '西藏', Shaanxi: '陕西', Gansu: '甘肃', Qinghai: '青海', Ningxia: '宁夏', Xinjiang: '新疆',
};

/** 城市名和坐标对不上时，超过这个距离就不认为是同一个地方 */
const MAX_KM = 40;

function km(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

const countryCode = (name: string | null | undefined) => (name ? (countries.getAlpha2Code(name, 'en') ?? null) : null);

export function countryZh(name: string | null | undefined): string | null {
  if (!name) return null;
  const code = countryCode(name);
  return (code && countries.getName(code, 'zh')) || name;
}

export function stateZh(state: string | null | undefined, country: string | null | undefined): string | null {
  if (!state) return null;
  const code = countryCode(country);
  if (code === 'CN' && PROVINCES[state]) return PROVINCES[state];
  return (code && data.admin1[`${code}|${state}`]) || state;
}

export function cityZh(city: string | null | undefined, country: string | null | undefined, lat?: number | null, lon?: number | null): string | null {
  if (!city) return null;
  const code = countryCode(country);
  const candidates = (data.cities[city] ?? []).filter((c) => !code || c[2] === code);
  if (!candidates.length) return city;
  if (lat == null || lon == null) return candidates.length === 1 ? candidates[0][3] : city;
  let best: CityRow | null = null;
  let bestKm = Infinity;
  for (const c of candidates) {
    const d = km(lat, lon, c[0], c[1]);
    if (d < bestKm) {
      best = c;
      bestKm = d;
    }
  }
  return best && bestKm <= MAX_KM ? best[3] : city;
}

/** 照片的拍摄地点，给人看的：“黄浦，上海，中国”（城市和省同名时只写一次） */
export function placeZh(p: { city?: string | null; state?: string | null; country?: string | null; latitude?: number | null; longitude?: number | null }) {
  const city = cityZh(p.city, p.country, p.latitude, p.longitude);
  const state = stateZh(p.state, p.country);
  const country = countryZh(p.country);
  return { city, state, country };
}
