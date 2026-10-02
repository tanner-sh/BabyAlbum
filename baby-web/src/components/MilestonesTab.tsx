import { useQueryClient } from '@tanstack/react-query';
import { Flag, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { request, thumbUrl, useAlbum, useMilestones, useMonth, type Baby, type Milestone } from '../api';
import { ageMonths, formatDate, today } from '../format';
import { Empty, ErrorBox, Modal, Spinner, useConfirm } from './ui';

export type MilestoneDraft = Partial<Milestone> & { date: string };

const PRESETS = ['第一次笑', '会抬头', '会翻身', '长第一颗牙', '会坐', '会爬', '叫爸爸妈妈', '会走路', '满月', '百天', '周岁', '上幼儿园'];

export function MilestonesTab({ baby, onEdit }: { baby: Baby; onEdit?: (draft: MilestoneDraft) => void }) {
  const album = useAlbum();
  const milestones = useMilestones(baby.id);

  if (milestones.isPending) return <Spinner />;
  if (milestones.isError) return <ErrorBox error={milestones.error} />;

  return (
    <>
      {onEdit && (
        <div className="section-actions">
          <p className="muted">记录第一次翻身、第一次走路……也可以在看照片时点 🚩 直接记录。</p>
          <button className="btn btn-primary" onClick={() => onEdit({ date: today() })}>
            <Plus size={16} />
            添加里程碑
          </button>
        </div>
      )}
      {!milestones.data.length ? (
        <Empty icon={<Flag size={40} />} title="还没有里程碑" />
      ) : (
        <ol className="milestones">
          {milestones.data.map((m) => (
            <li key={m.id} className="milestone">
              <div className="milestone-dot" />
              <div className="milestone-card">
                {m.coverAssetId && <img src={thumbUrl(album, m.coverAssetId, 'preview')} alt="" loading="lazy" />}
                <div className="milestone-body">
                  <h3>{m.title}</h3>
                  <p className="muted">
                    {formatDate(m.date)} · {m.ageLabel}
                  </p>
                  {m.note && <p className="milestone-note">{m.note}</p>}
                </div>
                {onEdit && (
                  <button className="icon-btn" onClick={() => onEdit(m)} aria-label="编辑">
                    <Pencil size={16} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

export function MilestoneEditor({ baby, draft, onClose }: { baby: Baby; draft: MilestoneDraft; onClose: () => void }) {
  const album = useAlbum();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(draft.title ?? '');
  const [date, setDate] = useState(draft.date);
  const [note, setNote] = useState(draft.note ?? '');
  const [cover, setCover] = useState<string | null>(draft.coverAssetId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 封面候选：当天拍的照片
  const months = date >= baby.birthday ? ageMonths(baby.birthday, date) : null;
  const month = useMonth(baby.id, months);
  const sameDay = useMemo(() => (month.data?.items ?? []).filter((i) => i.takenAt.startsWith(date) && i.type === 'IMAGE'), [month.data, date]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body = { title, date, note, coverAssetId: cover };
      if (draft.id) await request('PUT', `/api/milestones/${draft.id}`, body);
      else await request('POST', `/api/babies/${baby.id}/milestones`, body);
      await queryClient.invalidateQueries({ queryKey: [album.base, 'milestones', baby.id] });
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
      title: '删除里程碑',
      message: `删除“${draft.title}”？`,
      confirmLabel: '删除',
      danger: true,
      action: async () => {
        await request('DELETE', `/api/milestones/${draft.id}`);
        await queryClient.invalidateQueries({ queryKey: [album.base, 'milestones', baby.id] });
        onClose();
      },
    });
  }

  return (
    <Modal
      title={draft.id ? '编辑里程碑' : '记录里程碑'}
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
          <button className="btn btn-primary" disabled={!title.trim() || saving} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span>发生了什么</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：第一次叫妈妈" maxLength={100} autoFocus />
        </label>
        <div className="chips">
          {PRESETS.map((p) => (
            <button key={p} type="button" className={`chip ${title === p ? 'chip-accent' : ''}`} onClick={() => setTitle(p)}>
              {p}
            </button>
          ))}
        </div>
        <label className="field">
          <span>日期</span>
          <input type="date" value={date} min={baby.birthday} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>备注</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="想记下来的细节" maxLength={2000} />
        </label>
        <div className="field">
          <span>封面（当天的照片）</span>
          {month.isFetching ? (
            <Spinner />
          ) : sameDay.length ? (
            <div className="cover-picker">
              {sameDay.map((i) => (
                <button key={i.id} type="button" className={`cover-option ${cover === i.id ? 'selected' : ''}`} onClick={() => setCover(cover === i.id ? null : i.id)}>
                  <img src={thumbUrl(album, i.id)} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">这一天没有{baby.name}的照片</p>
          )}
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>
      {confirmDialog}
    </Modal>
  );
}
