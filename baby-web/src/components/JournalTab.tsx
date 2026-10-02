import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, NotebookPen, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { request, thumbUrl, useAlbum, useDay, useJournal, type AlbumItem, type Baby, type JournalEntry } from '../api';
import { formatDate, today } from '../format';
import { Lightbox } from './Lightbox';
import { Empty, ErrorBox, Modal, Spinner, useConfirm } from './ui';

/** 日记：给某一天写几句话，和当天的照片放在一起 */
export function JournalTab({ baby, onMilestone }: { baby: Baby; onMilestone?: (item: AlbumItem) => void }) {
  const album = useAlbum();
  const entries = useJournal(baby.id);
  const [editing, setEditing] = useState<Partial<JournalEntry> | null>(null);

  if (entries.isPending) return <Spinner />;
  if (entries.isError) return <ErrorBox error={entries.error} />;

  return (
    <>
      <div className="section-actions">
        <p className="muted">记下今天发生的小事，会和当天的照片放在一起。所有的日记、里程碑和每个月的照片可以导出成一本“成长书”。</p>
        <div className="actions-row">
          {!album.readOnly && (
            <Link className="btn" to={`/baby/${baby.id}/book`}>
              <BookOpen size={16} />
              成长书
            </Link>
          )}
          {!album.readOnly && (
            <button className="btn btn-primary" onClick={() => setEditing({ date: today() })}>
              <Plus size={16} />
              写日记
            </button>
          )}
        </div>
      </div>
      {!entries.data.length ? (
        <Empty icon={<NotebookPen size={40} />} title="还没有日记" />
      ) : (
        <ol className="journal">
          {entries.data.map((e) => (
            <JournalCard key={e.id} baby={baby} entry={e} onEdit={album.readOnly ? undefined : () => setEditing(e)} onMilestone={onMilestone} />
          ))}
        </ol>
      )}
      {editing && <JournalEditor baby={baby} draft={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function JournalCard({ baby, entry, onEdit, onMilestone }: { baby: Baby; entry: JournalEntry; onEdit?: () => void; onMilestone?: (item: AlbumItem) => void }) {
  const album = useAlbum();
  const day = useDay(baby.id, entry.date);
  const [open, setOpen] = useState<number | null>(null);
  const photos = day.data ?? [];
  const shown = photos.slice(0, 6);
  return (
    <li className="journal-entry">
      <header>
        <strong>{formatDate(entry.date)}</strong>
        <span className="muted">
          {baby.name}
          {entry.ageLabel}
          {entry.authorName && ` · ${entry.authorName}`}
        </span>
        {onEdit && (
          <button className="icon-btn" onClick={onEdit} aria-label="编辑">
            <Pencil size={14} />
          </button>
        )}
      </header>
      <p className="journal-text">{entry.text}</p>
      {shown.length > 0 && (
        <div className="journal-photos">
          {shown.map((p, i) => (
            <button key={p.id} onClick={() => setOpen(i)}>
              <img src={thumbUrl(album, p.id)} alt="" loading="lazy" />
              {i === shown.length - 1 && photos.length > shown.length && <span className="more">+{photos.length - shown.length}</span>}
            </button>
          ))}
        </div>
      )}
      {open !== null && <Lightbox items={photos} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} onMilestone={onMilestone} />}
    </li>
  );
}

function JournalEditor({ baby, draft, onClose }: { baby: Baby; draft: Partial<JournalEntry>; onClose: () => void }) {
  const album = useAlbum();
  const queryClient = useQueryClient();
  const [date, setDate] = useState(draft.date ?? today());
  const [text, setText] = useState(draft.text ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (draft.id) await request('PUT', `/api/journal/${draft.id}`, { date, text });
      else await request('POST', `/api/babies/${baby.id}/journal`, { date, text });
      await queryClient.invalidateQueries({ queryKey: [album.base, 'journal', baby.id] });
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
      title: '删除日记',
      message: '删除这篇日记？删除后找不回来。',
      confirmLabel: '删除',
      danger: true,
      action: async () => {
        await request('DELETE', `/api/journal/${draft.id}`);
        await queryClient.invalidateQueries({ queryKey: [album.base, 'journal', baby.id] });
        onClose();
      },
    });
  }

  return (
    <Modal
      title={draft.id ? '修改日记' : '写日记'}
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
          <button className="btn btn-primary" disabled={!text.trim() || saving} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span>日期</span>
          <input type="date" value={date} min={baby.birthday} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>今天发生了什么</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} maxLength={10000} autoFocus placeholder={`${baby.name}今天……`} />
        </label>
        {error && <div className="error-box">{error}</div>}
      </div>
      {confirmDialog}
    </Modal>
  );
}
