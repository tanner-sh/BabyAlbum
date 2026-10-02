import { useQueryClient } from '@tanstack/react-query';
import { BookImage, CheckSquare, Plus, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { request, thumbUrl, useAlbum, useAlbums, type PhotoAlbum } from '../api';
import { ErrorBox, Modal, Spinner, toast } from './ui';

/** 选一个相册，把照片加进去（也可以当场新建一个） */
export function AlbumPicker({ assetIds, onClose, onDone }: { assetIds: string[]; onClose: () => void; onDone?: (album: PhotoAlbum, added: number) => void }) {
  const album = useAlbum();
  const queryClient = useQueryClient();
  const albums = useAlbums();
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function addTo(target: PhotoAlbum) {
    setBusy(true);
    setError(null);
    try {
      const res = await request<{ added: number; album: PhotoAlbum }>('POST', `/api/albums/${target.id}/assets`, { assetIds });
      await queryClient.invalidateQueries({ queryKey: ['/api', 'albums'] });
      // 加好了直接关掉，用提示条告诉结果
      toast(res.added ? `已加入“${target.title}”` : `这些照片已经在“${target.title}”里了`);
      onDone?.(res.album, res.added);
      onClose();
      return;
    } catch (e) {
      setError(e instanceof Error ? e.message : '加入失败');
    } finally {
      setBusy(false);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await request<PhotoAlbum>('POST', '/api/albums', { title });
      setBusy(false);
      await addTo(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : '新建失败');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`加入相册（${assetIds.length} 张）`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      <>
        <form className="inline-fields album-new" onSubmit={create}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="新建相册，比如：满月酒" maxLength={50} />
          <button className="btn btn-primary" disabled={busy || !title.trim()}>
            <Plus size={16} />
            新建并加入
          </button>
        </form>
        {albums.isPending ? (
          <Spinner />
        ) : albums.isError ? (
          <ErrorBox error={albums.error} />
        ) : (
          <ul className="album-pick">
            {albums.data.map((a) => (
              <li key={a.id}>
                <button disabled={busy} onClick={() => addTo(a)}>
                  {a.coverAssetId ? <img src={thumbUrl(album, a.coverAssetId)} alt="" loading="lazy" /> : <span className="album-pick-empty"><BookImage size={20} /></span>}
                  <span>
                    <strong>{a.title}</strong>
                    <span className="muted small">{a.count} 张</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </>
      {error && <ErrorBox error={new Error(error)} />}
    </Modal>
  );
}

/** 多选：选中了几张照片之后，底部出现的操作栏 */
export function SelectionBar({ selected, onClear, extra }: { selected: Set<string>; onClear: () => void; extra?: React.ReactNode }) {
  const [picking, setPicking] = useState(false);
  return (
    <>
      <div className="selection-bar" role="toolbar">
        <span>
          <CheckSquare size={16} /> 已选 {selected.size} 张
        </span>
        <span className="spacer" />
        {extra}
        <button className="btn btn-primary" disabled={!selected.size} onClick={() => setPicking(true)}>
          <BookImage size={16} />
          加入相册
        </button>
        <button className="icon-btn" onClick={onClear} aria-label="取消选择">
          <X size={20} />
        </button>
      </div>
      {picking && (
        <AlbumPicker
          assetIds={[...selected]}
          // 加好了就退出选择；没加（取消）就保留选择
          onClose={() => setPicking(false)}
          onDone={onClear}
        />
      )}
    </>
  );
}

/** 多选状态：null 表示没在选 */
export function useSelection() {
  const [selected, setSelected] = useState<Set<string> | null>(null);
  return {
    selected,
    start: () => setSelected(new Set()),
    stop: () => setSelected(null),
    toggle: (id: string) =>
      setSelected((s) => {
        if (!s) return s;
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
  };
}
