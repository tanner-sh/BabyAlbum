import { ArrowLeft, Printer } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router';
import { thumbUrl, useAlbum, useBabies, useGrowth, useJournal, useMeasurements, useMilestones, type Baby } from '../api';
import { Avatar, Empty, ErrorBox, Spinner } from '../components/ui';
import { ageMonths, formatDate } from '../format';

/** 成长书：按月龄排版每个月的代表照片、里程碑、日记、成长数据，用浏览器“打印 → 存储为 PDF”导出 */
export function BookPage() {
  const { id } = useParams();
  const babies = useBabies();
  if (babies.isPending) return <Spinner />;
  if (babies.isError) return <ErrorBox error={babies.error} />;
  const baby = babies.data.find((b) => b.id === Number(id));
  if (!baby) return <Empty title="找不到这个宝宝" />;
  return <Book baby={baby} />;
}

function Book({ baby }: { baby: Baby }) {
  const album = useAlbum();
  const growth = useGrowth(baby.id);
  const milestones = useMilestones(baby.id);
  const journal = useJournal(baby.id);
  const measurements = useMeasurements(baby.id);

  const months = useMemo(() => {
    const byMonth = (date: string) => Math.max(0, ageMonths(baby.birthday, date));
    return (growth.data ?? []).map((cell) => ({
      ...cell,
      milestones: (milestones.data ?? []).filter((m) => byMonth(m.date) === cell.months).sort((a, b) => a.date.localeCompare(b.date)),
      journal: (journal.data ?? []).filter((e) => byMonth(e.date) === cell.months).sort((a, b) => a.date.localeCompare(b.date)),
      measurements: (measurements.data ?? []).filter((r) => byMonth(r.date) === cell.months),
    }));
  }, [growth.data, milestones.data, journal.data, measurements.data, baby.birthday]);

  if (growth.isPending || milestones.isPending || journal.isPending || measurements.isPending) return <Spinner label="正在排版…" />;
  const error = growth.error ?? milestones.error ?? journal.error ?? measurements.error;
  if (error) return <ErrorBox error={error} />;

  return (
    <div className="book">
      <div className="book-toolbar no-print">
        <Link className="btn" to={`/baby/${baby.id}?tab=records&view=journal`}>
          <ArrowLeft size={16} />
          返回
        </Link>
        <p className="muted">在浏览器里选“打印”，目标选“存储为 PDF”就能导出。照片较多时，等页面里的照片都加载出来再打印。</p>
        <button className="btn btn-primary" onClick={() => window.print()}>
          <Printer size={16} />
          打印 / 导出 PDF
        </button>
      </div>

      <section className="book-cover">
        <Avatar baby={baby} size={160} />
        <h1>{baby.name}的成长书</h1>
        <p>{formatDate(baby.birthday)} 出生</p>
      </section>

      {months
        .filter((m) => m.cover || m.milestones.length || m.journal.length || m.measurements.length)
        .map((m) => (
          <section key={m.months} className="book-month">
            <h2>
              {m.label}
              <span>{formatDate(m.from)} 起</span>
            </h2>
            {m.cover && <img className="book-photo" src={thumbUrl(album, m.cover.id, 'preview')} alt="" />}
            {m.measurements.map((r) => (
              <p key={r.id} className="book-measure">
                {formatDate(r.date)}：{[r.heightCm && `身高 ${r.heightCm} cm`, r.weightKg && `体重 ${r.weightKg} kg`, r.headCm && `头围 ${r.headCm} cm`].filter(Boolean).join('，')}
              </p>
            ))}
            {m.milestones.map((ms) => (
              <div key={ms.id} className="book-milestone">
                {ms.coverAssetId && ms.coverAssetId !== m.cover?.id && <img src={thumbUrl(album, ms.coverAssetId, 'preview')} alt="" />}
                <div>
                  <h3>🚩 {ms.title}</h3>
                  <p className="muted">
                    {formatDate(ms.date)} · {ms.ageLabel}
                  </p>
                  {ms.note && <p>{ms.note}</p>}
                </div>
              </div>
            ))}
            {m.journal.map((e) => (
              <div key={e.id} className="book-journal">
                <p className="muted">
                  {formatDate(e.date)} · {e.ageLabel}
                  {e.authorName && ` · ${e.authorName}`}
                </p>
                <p>{e.text}</p>
              </div>
            ))}
          </section>
        ))}
    </div>
  );
}
