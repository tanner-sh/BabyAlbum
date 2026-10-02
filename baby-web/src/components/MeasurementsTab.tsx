import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Ruler, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { request, useAlbum, useMeasurements, type Baby, type Measurement } from '../api';
import { daysBetween, formatDate, today } from '../format';
import { formatPercentile, percentile, PERCENTILES, valueAt, WHO_MAX_DAY, type Indicator } from '../who';
import { Empty, ErrorBox, Modal, Spinner, useConfirm } from './ui';

type Field = 'heightCm' | 'weightKg' | 'headCm';

const INDICATORS: { value: Indicator; label: string; unit: string; field: Field }[] = [
  { value: 'weight', label: '体重', unit: 'kg', field: 'weightKg' },
  { value: 'length', label: '身高', unit: 'cm', field: 'heightCm' },
  { value: 'head', label: '头围', unit: 'cm', field: 'headCm' },
];

/** 表格里按 身高、体重、头围 的顺序 */
const TABLE_COLUMNS = ['length', 'weight', 'head'].map((v) => INDICATORS.find((i) => i.value === v)!);

/** 成长数据：身高、体重、头围的记录和曲线，和 WHO 生长标准对比 */
export function MeasurementsTab({ baby }: { baby: Baby }) {
  const album = useAlbum();
  const records = useMeasurements(baby.id);
  const [indicator, setIndicator] = useState<Indicator>('weight');
  const [editing, setEditing] = useState<Partial<Measurement> | null>(null);

  if (records.isPending) return <Spinner />;
  if (records.isError) return <ErrorBox error={records.error} />;
  const meta = INDICATORS.find((i) => i.value === indicator)!;

  return (
    <>
      <div className="section-actions">
        <p className="muted">身高、体重、头围，和 WHO 儿童生长标准对比。</p>
        {!album.readOnly && (
          <button className="btn btn-primary" onClick={() => setEditing({ date: today() })}>
            <Plus size={16} />
            记一笔
          </button>
        )}
      </div>
      {!baby.sex && <p className="notice notice-info">还没有设置{baby.name}的性别，WHO 标准男孩和女孩不同，设置后才能对比（宝宝页右上角编辑）。</p>}
      {!records.data.length ? (
        <Empty icon={<Ruler size={40} />} title="还没有记录">
          体检本上的身高、体重、头围都可以记下来。
        </Empty>
      ) : (
        <>
          <div className="subtabs" role="tablist">
            {INDICATORS.map((i) => (
              <button key={i.value} role="tab" aria-selected={indicator === i.value} className={`subtab ${indicator === i.value ? 'active' : ''}`} onClick={() => setIndicator(i.value)}>
                {i.label}
              </button>
            ))}
          </div>
          <GrowthChart baby={baby} records={records.data} indicator={indicator} unit={meta.unit} field={meta.field} />
          <table className="measure-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>年龄</th>
                <th>身高 cm</th>
                <th>体重 kg</th>
                <th>头围 cm</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...records.data].reverse().map((r) => (
                <tr key={r.id}>
                  <td>{formatDate(r.date)}</td>
                  <td>{r.ageLabel}</td>
                  {TABLE_COLUMNS.map((i) => (
                    <td key={i.value}>
                      {r[i.field] ?? '—'}
                      {r[i.field] !== null && baby.sex && <span className="muted pct">{formatPercentile(percentile(i.value, baby.sex, r.ageDays, r[i.field]!))}</span>}
                    </td>
                  ))}
                  <td>
                    {r.note && <span className="muted note">{r.note}</span>}
                    {!album.readOnly && (
                      <button className="icon-btn" onClick={() => setEditing(r)} aria-label="编辑">
                        <Pencil size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {editing && <MeasurementEditor baby={baby} draft={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- 曲线图（SVG，不依赖图表库）

const PAD = { left: 40, right: 12, top: 12, bottom: 28 };

/** 元素的实际宽度：曲线按实际像素画，手机上文字才不会被缩得看不清 */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function GrowthChart({ baby, records, indicator, unit, field }: { baby: Baby; records: Measurement[]; indicator: Indicator; unit: string; field: Field }) {
  const points = records.filter((r) => r[field] !== null && r.ageDays >= 0).map((r) => ({ day: r.ageDays, value: r[field]!, r }));
  const sex = baby.sex;
  const [figRef, figWidth] = useWidth<HTMLElement>();
  const W = Math.max(300, figWidth);
  const H = W < 520 ? 240 : 320;

  const chart = useMemo(() => {
    // 横轴：从出生到最后一次测量之后一点，至少 1 岁，最多到 WHO 标准的 5 岁（测量更晚时延长）
    const lastDay = Math.max(...points.map((p) => p.day), daysBetween(baby.birthday, today()), 0);
    const maxDay = Math.max(365, Math.min(lastDay + 60, Math.max(WHO_MAX_DAY, lastDay + 30)));
    const curveEnd = Math.min(maxDay, WHO_MAX_DAY);
    const step = Math.max(7, Math.round(curveEnd / 120));
    const days: number[] = [];
    for (let d = 0; d <= curveEnd; d += step) days.push(d);
    if (days.at(-1) !== curveEnd) days.push(curveEnd);
    const curves = sex ? PERCENTILES.map((p) => days.map((d) => ({ day: d, value: valueAt(indicator, sex, d, p.z)! }))) : [];

    const values = [...points.map((p) => p.value), ...curves.flat().map((c) => c.value)];
    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const padV = (maxV - minV) * 0.06 || 1;
    return { maxDay, curves, minV: Math.max(0, minV - padV), maxV: maxV + padV };
  }, [points, sex, indicator, baby.birthday]);

  const x = (day: number) => PAD.left + (day / chart.maxDay) * (W - PAD.left - PAD.right);
  const y = (v: number) => H - PAD.bottom - ((v - chart.minV) / (chart.maxV - chart.minV)) * (H - PAD.top - PAD.bottom);
  const line = (pts: { day: number; value: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const band = (lower: { day: number; value: number }[], upper: { day: number; value: number }[]) => `${line(lower)}${line([...upper].reverse()).replace('M', 'L')}Z`;

  // 横轴刻度：2 岁以内每 3 个月，之后每 6 个月
  const ticks: number[] = [];
  const stepMonths = chart.maxDay > 900 ? (W < 520 ? 12 : 6) : W < 520 ? 6 : 3;
  for (let m = 0; m * 30.4375 <= chart.maxDay; m += stepMonths) ticks.push(m);
  const yTicks = niceTicks(chart.minV, chart.maxV, 6);

  return (
    <figure className="growth-chart" ref={figRef}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${baby.name}的${indicator === 'weight' ? '体重' : indicator === 'length' ? '身高' : '头围'}曲线`}>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="grid-line" />
            <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" className="axis">
              {v}
            </text>
          </g>
        ))}
        {ticks.map((m) => (
          <text key={m} x={x(m * 30.4375)} y={H - 10} textAnchor="middle" className="axis">
            {m === 0 ? '出生' : m % 12 === 0 ? `${m / 12}岁` : `${m}月`}
          </text>
        ))}
        {chart.curves.length === 5 && (
          <>
            <path d={band(chart.curves[0], chart.curves[4])} className="band-outer" />
            <path d={band(chart.curves[1], chart.curves[3])} className="band-inner" />
            <path d={line(chart.curves[2])} className="median" />
          </>
        )}
        {points.length > 1 && <path d={line(points)} className="baby-line" />}
        {points.map((p) => (
          <circle key={p.r.id} cx={x(p.day)} cy={y(p.value)} r={4} className="baby-point">
            <title>
              {formatDate(p.r.date)}（{p.r.ageLabel}）：{p.value} {unit}
              {sex ? ` · ${formatPercentile(percentile(indicator, sex, p.day, p.value))}` : ''}
            </title>
          </circle>
        ))}
      </svg>
      <figcaption className="muted">
        单位：{unit}
        {sex && ' · 图例：浅色 P3–P97，深色 P15–P85，虚线 P50'}
      </figcaption>
    </figure>
  );
}

/** 坐标轴上好看的刻度（1、2、5 的倍数） */
function niceTicks(min: number, max: number, count: number) {
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

// ---------------------------------------------------------------- 录入

function MeasurementEditor({ baby, draft, onClose }: { baby: Baby; draft: Partial<Measurement>; onClose: () => void }) {
  const album = useAlbum();
  const queryClient = useQueryClient();
  const [date, setDate] = useState(draft.date ?? today());
  const [height, setHeight] = useState(draft.heightCm?.toString() ?? '');
  const [weight, setWeight] = useState(draft.weightKg?.toString() ?? '');
  const [head, setHead] = useState(draft.headCm?.toString() ?? '');
  const [note, setNote] = useState(draft.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const num = (s: string) => (s.trim() ? Number(s) : null);
  const valid = [height, weight, head].some((v) => v.trim()) && [height, weight, head].every((v) => !v.trim() || Number.isFinite(Number(v)));

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const body = { date, heightCm: num(height), weightKg: num(weight), headCm: num(head), note };
      if (draft.id) await request('PUT', `/api/measurements/${draft.id}`, body);
      else await request('POST', `/api/babies/${baby.id}/measurements`, body);
      await queryClient.invalidateQueries({ queryKey: [album.base, 'measurements', baby.id] });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      setSaving(false);
    }
  }

  const [ask, confirmDialog] = useConfirm();
  function remove() {
    if (!draft.id) return;
    ask({
      title: '删除记录',
      message: '删除这条成长数据？',
      confirmLabel: '删除',
      danger: true,
      action: async () => {
        await request('DELETE', `/api/measurements/${draft.id}`);
        await queryClient.invalidateQueries({ queryKey: [album.base, 'measurements', baby.id] });
        onClose();
      },
    });
  }

  return (
    <Modal
      title={draft.id ? '修改记录' : '记一笔成长数据'}
      onClose={onClose}
      footer={
        <>
          {draft.id && (
            <button className="btn btn-danger-ghost" onClick={remove}>
              <Trash2 size={16} />
              删除
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!valid || saving} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span>测量日期</span>
          <input type="date" value={date} min={baby.birthday} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
        <div className="inline-fields">
          <label className="field">
            <span>身高 / 身长（cm）</span>
            <input inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} placeholder="例如 75.5" />
          </label>
          <label className="field">
            <span>体重（kg）</span>
            <input inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="例如 9.6" />
          </label>
          <label className="field">
            <span>头围（cm）</span>
            <input inputMode="decimal" value={head} onChange={(e) => setHead(e.target.value)} placeholder="例如 46" />
          </label>
        </div>
        <p className="muted small">至少填一项。2 岁以内一般躺着量身长，2 岁以后站着量身高。</p>
        <label className="field">
          <span>备注</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="例如：6 月龄体检" />
        </label>
        {error && <div className="error-box">{error}</div>}
      </div>
      {confirmDialog}
    </Modal>
  );
}
