import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EyeOff, FileWarning, Film, Image as ImageIcon, Timer } from 'lucide-react';
import { useState } from 'react';
import { get, request, type ImportProgress, type TypeProgress } from '../../api';
import { formatBytes } from '../../format';
import { attempt } from '../../components/ui';

/** 剩余时间：不到 1 小时显示分钟，2 天以上显示天 */
export function formatEta(hours: number | null): string {
  if (hours === null) return '估算中';
  if (hours === 0) return '已完成';
  if (hours < 1) return `约 ${Math.max(1, Math.round(hours * 60))} 分钟`;
  if (hours < 48) return `约 ${Math.round(hours)} 小时`;
  return `约 ${Math.round(hours / 24)} 天`;
}

const formatRate = (rate: number | null) => (rate === null ? '—' : rate >= 100 ? `${Math.round(rate).toLocaleString()} 个/小时` : `${rate.toFixed(1)} 个/小时`);

/** 导入进度：照片、视频各还剩多少没处理，最近的速度，预计还要多久 */
export function ImportProgressCard() {
  const progress = useQuery({
    queryKey: ['admin', 'import-progress'],
    queryFn: () => get<ImportProgress>('/api/admin/import-progress'),
    refetchInterval: 30_000,
  });
  const p = progress.data;
  if (!p) return null;
  const pending = (p.photos?.pending ?? 0) + (p.videos?.pending ?? 0);
  const unreadable = p.unreadable ?? [];
  if (!p.importing && !pending) return unreadable.length ? <UnreadableFiles files={unreadable} /> : null;
  const busy = p.stages.filter((s) => s.remaining > 0);

  return (
    <section className="card import-progress">
      <div className="section-actions">
        <div>
          <h2>
            <Timer size={18} /> 导入进度
          </h2>
          <p className="muted">
            照片读完拍摄信息后就会出现在相册里；视频要从存储上完整读一遍，比照片慢得多。照片和视频按导入顺序排队处理，同一时间往往只处理其中一类。
            {p.sampledMinutes < 15 && ' 刚开始统计，速度要过十几分钟才准。'}
          </p>
        </div>
      </div>
      <div className="stats">
        <TypeStat icon={<ImageIcon size={16} />} label="照片" unit="张" t={p.photos} counting={p.counting} />
        <TypeStat icon={<Film size={16} />} label="视频" unit="个" t={p.videos} counting={p.counting} />
      </div>
      {busy.length > 0 && (
        <table className="progress-table">
          <thead>
            <tr>
              <th>步骤</th>
              <th>剩余</th>
              <th>最近速度</th>
              <th>预计</th>
            </tr>
          </thead>
          <tbody>
            {busy.map((s) => (
              <tr key={s.name}>
                <td>{s.label}</td>
                <td>{s.remaining.toLocaleString()}</td>
                <td>{formatRate(s.ratePerHour)}</td>
                <td>{formatEta(s.etaHours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {unreadable.length > 0 && <UnreadableFiles files={unreadable} inline />}
      {p.countedAt && (
        <p className="muted small">
          照片、视频的数量每 10 分钟统计一次，上次统计：{new Date(p.countedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
          {p.counting && '（正在统计…）'}
        </p>
      )}
    </section>
  );
}

/** 导入结束后还读不出来的文件：存储上的文件是空的或者没拷完整，Immich 读不了，会一直卡在“还剩” */
function UnreadableFiles({ files, inline }: { files: ImportProgress['unreadable']; inline?: boolean }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function hideAll() {
    setBusy(true);
    const ok = await attempt(() => request('POST', '/api/admin/hidden', { assetIds: files.map((f) => f.id), reason: '文件损坏' }), '已在相册里隐藏，可以在“整理”里恢复');
    if (ok) await queryClient.invalidateQueries({ queryKey: ['admin'] });
    setBusy(false);
  }
  const small = files.filter((f) => f.size !== null && f.size < 64 * 1024).length;
  const body = (
    <>
      <h3>
        <FileWarning size={18} /> 有 {files.length} 个文件读不出来
      </h3>
      <p className="muted">
        {small === files.length ? '这些文件在存储上是空的，或者只有很小一点（没拷完整、录像没正常结束），' : '这些文件可能已损坏，'}
        照片服务读不了，导入不进来。可以在存储上找到原文件重新拷贝（拷好后会自动重新导入）；确实没用的，可以在相册里隐藏，不显示成“处理中”的空格子。
      </p>
      <ul className="unreadable-list">
        {files.map((f) => (
          <li key={f.id}>
            {f.type === 'video' ? <Film size={14} /> : <ImageIcon size={14} />}
            <span className="unreadable-path">{f.path}</span>
            <span className="muted small">{f.size === null ? '找不到文件' : f.size === 0 ? '空文件（0 字节）' : formatBytes(f.size)}</span>
          </li>
        ))}
      </ul>
      <button className="btn btn-small" disabled={busy} onClick={hideAll}>
        <EyeOff size={14} /> 在相册里隐藏这些文件
      </button>
    </>
  );
  return inline ? <div className="unreadable">{body}</div> : <section className="card import-progress unreadable">{body}</section>;
}

function TypeStat({ icon, label, unit, t, counting }: { icon: React.ReactNode; label: string; unit: string; t: TypeProgress | null; counting: boolean }) {
  if (!t) {
    return (
      <div className="stat">
        <span className="muted">
          {icon} {label}
        </span>
        <strong>{counting ? '统计中…' : '—'}</strong>
      </div>
    );
  }
  const done = t.total - t.pending;
  const percent = t.total ? Math.floor((done / t.total) * 100) : 100;
  return (
    <div className="stat">
      <span className="muted">
        {icon} {label}
      </span>
      <strong>{t.pending ? `还剩 ${t.pending.toLocaleString()} ${unit}` : '全部完成'}</strong>
      <div className="progress-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className="muted">
        已处理 {done.toLocaleString()} / {t.total.toLocaleString()}（{percent}%）
        {t.pending > 0 && (t.queued ? ' · 排队中，等另一类处理完' : ` · ${formatEta(t.etaHours)}`)}
      </span>
    </div>
  );
}
