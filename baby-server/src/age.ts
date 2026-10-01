// 宝宝年龄计算，只按日期计算，不涉及时区：
// Immich 的 localDateTime 是拍摄地的本地时间，取前 10 位 YYYY-MM-DD 即可

export type Age = {
  /** 出生后的总天数，出生前为负数 */
  days: number;
  /** 满几个月（总月数） */
  months: number;
  /** 满月之后多出来的天数 */
  extraDays: number;
  /** 例如 “出生第 5 天”、“3 个月 12 天”、“1 岁 2 个月” */
  label: string;
  /** 分组用：按月龄分组，例如 “3 个月”、“1 岁 2 个月” */
  groupLabel: string;
};

const DAY_MS = 86_400_000;

function parseDate(s: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!match) throw new Error(`无法解析日期：${s}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function toUtc(y: number, m: number, d: number) {
  return Date.UTC(y, m - 1, d);
}

/** 生日加 n 个月；目标月份没有这一天时取月末（1 月 31 日 + 1 个月 = 2 月 28/29 日） */
function addMonths(birth: { y: number; m: number; d: number }, n: number) {
  const total = birth.y * 12 + (birth.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return toUtc(y, m, Math.min(birth.d, lastDay));
}

function monthsLabel(months: number) {
  if (months < 12) return `${months} 个月`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years} 岁 ${rest} 个月` : `${years} 岁`;
}

export function computeAge(birthday: string, takenAt: string): Age {
  const birth = parseDate(birthday);
  const taken = parseDate(takenAt);
  const takenUtc = toUtc(taken.y, taken.m, taken.d);
  const days = Math.round((takenUtc - toUtc(birth.y, birth.m, birth.d)) / DAY_MS);

  if (days < 0) {
    return { days, months: 0, extraDays: 0, label: '出生前', groupLabel: '出生前' };
  }

  let months = (taken.y - birth.y) * 12 + (taken.m - birth.m);
  if (addMonths(birth, months) > takenUtc) months--;
  const extraDays = Math.round((takenUtc - addMonths(birth, months)) / DAY_MS);

  let label: string;
  if (days === 0) label = '出生当天';
  else if (months === 0) label = `出生第 ${days} 天`;
  else if (months < 12) label = extraDays ? `${months} 个月 ${extraDays} 天` : `${months} 个月`;
  else label = monthsLabel(months);

  const groupLabel = months === 0 ? '新生儿（0–1 个月）' : monthsLabel(months);
  return { days, months, extraDays, label, groupLabel };
}

const fmt = (utc: number) => new Date(utc).toISOString().slice(0, 10);

/** 满 n 个月的那一天（YYYY-MM-DD） */
export function monthDate(birthday: string, n: number): string {
  return fmt(addMonths(parseDate(birthday), n));
}

/** 日期加减天数（YYYY-MM-DD） */
export function shiftDays(date: string, n: number): string {
  const { y, m, d } = parseDate(date);
  return fmt(toUtc(y, m, d) + n * DAY_MS);
}

/** 当前的月龄 */
export function currentMonths(birthday: string, today = localToday()): number {
  return computeAge(birthday, today).months;
}

/** 服务器所在时区的今天（YYYY-MM-DD），时区由 TZ 环境变量决定 */
export function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
