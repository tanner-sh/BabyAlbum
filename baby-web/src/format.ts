// 与 baby-server/src/age.ts 相同的月龄规则（前端只需要月数，用于选择里程碑封面等）

function parse(s: string) {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return { y, m, d };
}

export function ageMonths(birthday: string, date: string): number {
  const b = parse(birthday);
  const t = parse(date);
  let months = (t.y - b.y) * 12 + (t.m - b.m);
  const anchor = (n: number) => {
    const total = b.y * 12 + (b.m - 1) + n;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return Date.UTC(y, m - 1, Math.min(b.d, last));
  };
  if (anchor(months) > Date.UTC(t.y, t.m - 1, t.d)) months--;
  return months;
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

export function formatBytes(n: number | null): string {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
