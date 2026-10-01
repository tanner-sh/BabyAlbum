// 与 baby-server/src/age.ts 相同的月龄规则（前端只需要月数，用于选择里程碑封面等）

function parse(s: string) {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return { y, m, d };
}

/** 生日加 n 个月（UTC 毫秒）；目标月份没有这一天时取月末 */
function anchor(birthday: string, n: number) {
  const b = parse(birthday);
  const total = b.y * 12 + (b.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Date.UTC(y, m - 1, Math.min(b.d, last));
}

export function ageMonths(birthday: string, date: string): number {
  const b = parse(birthday);
  const t = parse(date);
  let months = (t.y - b.y) * 12 + (t.m - b.m);
  if (anchor(birthday, months) > Date.UTC(t.y, t.m - 1, t.d)) months--;
  return months;
}

/** 满 n 个月的那一天（YYYY-MM-DD） */
export function monthDate(birthday: string, n: number): string {
  return new Date(anchor(birthday, n)).toISOString().slice(0, 10);
}

/** 两个日期相差的天数 */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 86_400_000);
}

/** 月龄的说法，和后端 age.ts 一致：3 个月、1 岁 2 个月 */
export function monthsLabel(months: number): string {
  if (months < 12) return `${months} 个月`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years} 岁 ${rest} 个月` : `${years} 岁`;
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 2024-05-01T10:20:00.000Z → 2024年5月1日 10:20（localDateTime 是本地时间，按字面显示） */
export function formatDateTime(s: string, withTime = true): string {
  const [date, time] = s.split('T');
  const [y, m, d] = date.split('-').map(Number);
  return `${y}年${m}月${d}日${withTime && time ? ` ${time.slice(0, 5)}` : ''}`;
}

export function formatDate(s: string): string {
  return formatDateTime(s, false);
}

export function formatDuration(ms: number | null): string {
  if (!ms) return '';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 按 1024 换算，统一显示成 B / KB / MB / GB / TB */
export function formatBytes(n: number | null): string {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
