import { ChevronLeft, ChevronRight, Columns2 } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useBabies, useMonth, type Baby } from '../api';
import { Lightbox } from '../components/Lightbox';
import { PhotoGrid } from '../components/PhotoGrid';
import { Avatar, Empty, ErrorBox, Spinner } from '../components/ui';
import { ageMonths, formatDate, today } from '../format';

const PRESETS = [
  { months: 0, label: '新生儿' },
  { months: 1, label: '满月' },
  { months: 3, label: '百天' },
  { months: 6, label: '半岁' },
  { months: 12, label: '1 岁' },
  { months: 18, label: '1 岁半' },
  { months: 24, label: '2 岁' },
  { months: 36, label: '3 岁' },
];

const monthsLabel = (m: number) => (m === 0 ? '新生儿' : m < 12 ? `${m} 个月` : m % 12 ? `${Math.floor(m / 12)} 岁 ${m % 12} 个月` : `${m / 12} 岁`);

/** 同龄对比：几个宝宝在同一个月龄时的照片并排看。在宝宝页“回顾”里，旧的 /compare 地址也还能用 */
export function ComparePage() {
  return <CompareView />;
}

export function CompareView() {
  const babies = useBabies();
  const [params, setParams] = useSearchParams();
  const months = Math.max(0, Number(params.get('m') ?? 12) || 0);
  // 只改月龄，不动地址里的其他参数（在宝宝页里还有 tab、view）
  const setMonths = (m: number) =>
    setParams(
      (p) => {
        p.set('m', String(Math.max(0, m)));
        return p;
      },
      { replace: true },
    );

  if (babies.isPending) return <Spinner />;
  if (babies.isError) return <ErrorBox error={babies.error} />;
  if (babies.data.length < 2) {
    return (
      <Empty icon={<Columns2 size={40} />} title="需要至少两个宝宝">
        同龄对比会把几个宝宝在同一个月龄时的照片并排展示，比如老大和老二满月时的样子。
      </Empty>
    );
  }

  const maxMonths = Math.max(...babies.data.map((b) => ageMonths(b.birthday, today())));

  return (
    <>
      <div className="compare-bar">
        <button className="icon-btn" onClick={() => setMonths(months - 1)} disabled={months === 0} aria-label="上一个月">
          <ChevronLeft size={20} />
        </button>
        <h1>{monthsLabel(months)}</h1>
        <button className="icon-btn" onClick={() => setMonths(months + 1)} disabled={months >= maxMonths} aria-label="下一个月">
          <ChevronRight size={20} />
        </button>
      </div>
      <div className="chips center">
        {PRESETS.filter((p) => p.months <= maxMonths).map((p) => (
          <button key={p.months} className={`chip ${months === p.months ? 'chip-accent' : ''}`} onClick={() => setMonths(p.months)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="compare-columns" style={{ '--cols': babies.data.length } as React.CSSProperties}>
        {babies.data.map((b) => (
          <CompareColumn key={b.id} baby={b} months={months} />
        ))}
      </div>
    </>
  );
}

function CompareColumn({ baby, months }: { baby: Baby; months: number }) {
  const notYet = ageMonths(baby.birthday, today()) < months;
  const month = useMonth(baby.id, notYet ? null : months);
  const [open, setOpen] = useState<number | null>(null);

  return (
    <section className="compare-column">
      <header>
        <Avatar baby={baby} size={36} />
        <div>
          <strong>{baby.name}</strong>
          {month.data && <span className="muted">{formatDate(month.data.from)} 起</span>}
        </div>
      </header>
      {notYet ? (
        <p className="muted compare-note">还没到这个月龄</p>
      ) : month.isPending ? (
        <Spinner />
      ) : month.isError ? (
        <ErrorBox error={month.error} />
      ) : month.data.items.length === 0 ? (
        <p className="muted compare-note">这个月没有照片</p>
      ) : (
        <PhotoGrid items={month.data.items} onOpen={setOpen} />
      )}
      {open !== null && month.data && (
        <Lightbox items={month.data.items} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />
      )}
    </section>
  );
}
