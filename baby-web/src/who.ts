// WHO 生长标准的计算（LMS 法）：
//   某个 z 值对应的测量值 X = M·(1 + L·S·z)^(1/L)（L = 0 时 X = M·e^(S·z)）
//   测量值对应的 z 值   z = ((X/M)^L − 1) / (L·S)（L = 0 时 z = ln(X/M) / S）
// 百分位 = 标准正态分布的累积概率 Φ(z)

import { WHO_LMS, type Indicator, type LmsRow, type Sex } from './who-growth';

export type { Indicator, Sex };

/** WHO 标准覆盖的最大天数（5 岁） */
export const WHO_MAX_DAY = 1856;

/** 常用的百分位线及对应的 z 值 */
export const PERCENTILES = [
  { p: 3, z: -1.881 },
  { p: 15, z: -1.036 },
  { p: 50, z: 0 },
  { p: 85, z: 1.036 },
  { p: 97, z: 1.881 },
];

/** 某一天的 L、M、S，在相邻两个点之间线性插值；超出 0–5 岁返回 null */
function lmsAt(indicator: Indicator, sex: Sex, day: number): [number, number, number] | null {
  const rows: LmsRow[] = WHO_LMS[indicator][sex];
  if (day < 0 || day > WHO_MAX_DAY) return null;
  let i = Math.min(rows.length - 2, Math.max(0, Math.floor(day / 7)));
  while (i < rows.length - 2 && rows[i + 1][0] < day) i++;
  const [d0, L0, M0, S0] = rows[i];
  const [d1, L1, M1, S1] = rows[i + 1];
  const t = d1 === d0 ? 0 : (day - d0) / (d1 - d0);
  return [L0 + (L1 - L0) * t, M0 + (M1 - M0) * t, S0 + (S1 - S0) * t];
}

export function valueAt(indicator: Indicator, sex: Sex, day: number, z: number): number | null {
  const lms = lmsAt(indicator, sex, day);
  if (!lms) return null;
  const [L, M, S] = lms;
  return L === 0 ? M * Math.exp(S * z) : M * Math.pow(1 + L * S * z, 1 / L);
}

export function zScore(indicator: Indicator, sex: Sex, day: number, value: number): number | null {
  const lms = lmsAt(indicator, sex, day);
  if (!lms || value <= 0) return null;
  const [L, M, S] = lms;
  return L === 0 ? Math.log(value / M) / S : (Math.pow(value / M, L) - 1) / (L * S);
}

/** 标准正态分布的累积概率（Abramowitz–Stegun 7.1.26 近似，误差 < 1.5e-7） */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** 测量值在同龄同性别孩子里的百分位（0–100） */
export function percentile(indicator: Indicator, sex: Sex, day: number, value: number): number | null {
  const z = zScore(indicator, sex, day, value);
  return z === null ? null : normalCdf(z) * 100;
}

/** “P62”这样的说法；极端值说“低于 P1”“高于 P99” */
export function formatPercentile(p: number | null): string {
  if (p === null) return '';
  if (p < 1) return '低于 P1';
  if (p > 99) return '高于 P99';
  return `P${Math.round(p)}`;
}
