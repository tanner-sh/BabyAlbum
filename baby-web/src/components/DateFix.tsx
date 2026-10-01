import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, RotateCcw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { request, useAssetInfo, useDateIssues, type Baby, type DateIssueGroup } from '../api';
import { formatDate, formatDateTime } from '../format';
import { PhotoGrid } from './PhotoGrid';
import { ErrorBox, Modal, Spinner } from './ui';

// 拍摄日期更正：只在宝宝相册里生效，不修改 NAS 上的原文件，也不修改 Immich

function useAfterDateChange() {
  const queryClient = useQueryClient();
  // 日期变了，时间线、成长墙、那年今日等全部要重新加载
  return () => queryClient.invalidateQueries();
}

/** 宝宝页面顶部的提示：有照片的日期早于出生日期 */
export function DateIssuesBanner({ baby }: { baby: Baby }) {
  const issues = useDateIssues(baby.id);
  const [open, setOpen] = useState(false);
  const count = issues.data?.reduce((n, g) => n + g.items.length, 0) ?? 0;
  if (!count) return null;
  return (
    <>
      <button className="notice" onClick={() => setOpen(true)}>
        <TriangleAlert size={18} />
        <span>
          有 <strong>{count}</strong> 张{baby.name}的照片日期不对（早于出生日期），通常是影楼相册设计页或相机时间没调。点这里更正
        </span>
      </button>
      {open && <DateIssuesModal baby={baby} groups={issues.data!} onClose={() => setOpen(false)} />}
    </>
  );
}

function DateIssuesModal({ baby, groups, onClose }: { baby: Baby; groups: DateIssueGroup[]; onClose: () => void }) {
  const refresh = useAfterDateChange();
  const [dates, setDates] = useState<Record<string, string>>(() => Object.fromEntries(groups.map((g) => [g.folder, g.suggestedDate ?? ''])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fix(list: DateIssueGroup[]) {
    setBusy(true);
    setError(null);
    try {
      for (const g of list) {
        const date = dates[g.folder];
        if (!date) continue;
        await request('POST', '/api/date-overrides', { assetIds: g.items.map((i) => i.id), takenAt: date });
      }
      await refresh();
      if (list.length === groups.length) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '更正失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="更正拍摄日期"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted">只在宝宝相册里生效，不会修改存储上的原文件</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            稍后再说
          </button>
          <button className="btn btn-primary" disabled={busy || groups.some((g) => !dates[g.folder])} onClick={() => fix(groups)}>
            全部按建议日期更正
          </button>
        </>
      }
    >
      <p className="muted">
        这些照片里有{baby.name}，日期却在 {formatDate(baby.birthday)} 出生之前，肯定不对。建议日期取自同一文件夹里其他照片最集中的那一天，可以修改。
      </p>
      {error && <ErrorBox error={new Error(error)} />}
      {groups.map((g) => (
        <section key={g.folder} className="issue-group">
          <header className="issue-header">
            <div>
              <strong>{g.folder}</strong>
              <span className="muted">
                {g.items.length} 张，原日期：{[...new Set(g.items.map((i) => formatDate(i.takenAt)))].slice(0, 4).join('、')}
                {new Set(g.items.map((i) => i.takenAt.slice(0, 10))).size > 4 ? ' 等' : ''}
              </span>
            </div>
            <div className="issue-actions">
              <input
                type="date"
                value={dates[g.folder]}
                min={baby.birthday}
                onChange={(e) => setDates((d) => ({ ...d, [g.folder]: e.target.value }))}
                aria-label="更正为"
              />
              <button className="btn" disabled={busy || !dates[g.folder]} onClick={() => fix([g])}>
                更正这 {g.items.length} 张
              </button>
            </div>
          </header>
          <PhotoGrid items={g.items} onOpen={() => {}} caption={(i) => formatDate(i.takenAt)} />
        </section>
      ))}
    </Modal>
  );
}

/** 查看大图时修改单张照片的日期 */
export function EditDateModal({ assetId, onClose }: { assetId: string; onClose: () => void }) {
  const info = useAssetInfo(assetId);
  const refresh = useAfterDateChange();
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = value ?? info.data?.takenAt.slice(0, 16) ?? '';

  async function save() {
    try {
      await request('POST', '/api/date-overrides', { assetIds: [assetId], takenAt: current });
      await refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  }

  async function restore() {
    try {
      await request('DELETE', `/api/date-overrides/${assetId}`);
      await refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '恢复失败');
    }
  }

  return (
    <Modal
      title="修改拍摄日期"
      onClose={onClose}
      footer={
        <>
          {info.data?.originalTakenAt && (
            <button className="btn btn-danger-ghost" onClick={restore}>
              <RotateCcw size={16} />
              恢复原始日期
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!current} onClick={save}>
            保存
          </button>
        </>
      }
    >
      {info.isPending ? (
        <Spinner />
      ) : (
        <div className="form">
          <label className="field">
            <span>
              <CalendarClock size={14} /> 拍摄时间
            </span>
            <input type="datetime-local" value={current} onChange={(e) => setValue(e.target.value)} />
          </label>
          {info.data?.originalTakenAt && <p className="muted">原始日期：{formatDateTime(info.data.originalTakenAt)}（来自照片文件）</p>}
          <p className="muted">只在宝宝相册里生效，不会修改存储上的原文件和 Immich。</p>
          {error && <div className="error-box">{error}</div>}
        </div>
      )}
    </Modal>
  );
}
