import { useQueryClient } from '@tanstack/react-query';
import { BookImage, ImagePlus, Pencil, Play, Plus, Share2, Star, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router';
import { canEdit, request, thumbUrl, useAlbum, useAlbumDetail, useAlbums, type Me, type PhotoAlbum } from '../api';
import { Lightbox } from '../components/Lightbox';
import { PhotoGrid } from '../components/PhotoGrid';
import { useSelection } from '../components/AlbumPicker';
import { PhotosTabs } from '../components/SectionTabs';
import { Slideshow } from '../components/Slideshow';
import { attempt, Empty, ErrorBox, Modal, Spinner, useConfirm } from '../components/ui';
import { formatDate } from '../format';
import { ShareEditor } from './SharesPage';

/** 相册列表：自己挑照片建的相册 */
export function AlbumsPage() {
  const me = useOutletContext<Me>();
  const album = useAlbum();
  const albums = useAlbums();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  if (albums.isPending) return <Spinner />;
  if (albums.isError) return <ErrorBox error={albums.error} />;

  return (
    <>
      <PhotosTabs />
      <div className="section-actions">
        <p className="muted">自己挑照片建的相册，每个相册可以单独分享。在时间线上点“选择”可以一次加很多张。</p>
        {canEdit(me) && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={16} />
            新建相册
          </button>
        )}
      </div>
      {!albums.data.length ? (
        <Empty icon={<BookImage size={40} />} title="还没有相册" />
      ) : (
        <div className="album-grid">
          {albums.data.map((a) => (
            <Link key={a.id} to={`/albums/${a.id}`} className="album-card">
              {a.coverAssetId ? <img src={thumbUrl(album, a.coverAssetId, 'preview')} alt="" loading="lazy" /> : <span className="album-card-empty"><BookImage size={36} /></span>}
              <span className="album-card-text">
                <strong>{a.title}</strong>
                <span className="muted small">{a.count} 张</span>
              </span>
            </Link>
          ))}
        </div>
      )}
      {creating && <AlbumEditor onClose={() => setCreating(false)} onSaved={(a) => navigate(`/albums/${a.id}`)} />}
    </>
  );
}

function AlbumEditor({ album, onClose, onSaved }: { album?: PhotoAlbum; onClose: () => void; onSaved?: (a: PhotoAlbum) => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(album?.title ?? '');
  const [description, setDescription] = useState(album?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (saving || !title.trim()) return;
    setError(null);
    setSaving(true);
    try {
      const saved = album
        ? await request<PhotoAlbum>('PUT', `/api/albums/${album.id}`, { title, description })
        : await request<PhotoAlbum>('POST', '/api/albums', { title, description });
      await queryClient.invalidateQueries({ queryKey: ['/api', 'albums'] });
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
      setSaving(false);
    }
  }
  return (
    <Modal
      title={album ? '修改相册' : '新建相册'}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!title.trim() || saving} onClick={() => save()}>
            保存
          </button>
        </>
      }
    >
      <form className="form" onSubmit={save}>
        <label className="field">
          <span>名字</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={50} placeholder="比如：满月酒" autoFocus />
        </label>
        <label className="field">
          <span>介绍（可以不填）</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={3} />
        </label>
        {error && <div className="error-box">{error}</div>}
      </form>
    </Modal>
  );
}

/** 一个相册：照片按拍摄时间排，可以播放、分享、移出照片、设封面 */
export function AlbumPage() {
  const me = useOutletContext<Me>();
  const { id } = useParams();
  const albumId = Number(id);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detail = useAlbumDetail(albumId);
  const selection = useSelection();
  const [open, setOpen] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const editable = canEdit(me);
  const [ask, confirmDialog] = useConfirm();

  if (detail.isPending) return <Spinner />;
  if (detail.isError) return <ErrorBox error={detail.error} />;
  const { album, items } = detail.data;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['/api', 'albums'] });

  function removeSelected() {
    const ids = [...(selection.selected ?? [])];
    if (!ids.length) return;
    ask({
      title: '移出相册',
      message: `把选中的 ${ids.length} 张移出相册？照片本身不受影响。`,
      confirmLabel: '移出',
      danger: true,
      action: async () => {
        await request('POST', `/api/albums/${albumId}/assets/remove`, { assetIds: ids });
        selection.stop();
        await refresh();
      },
    });
  }

  async function setCover() {
    const [first] = selection.selected ?? [];
    if (!first) return;
    const ok = await attempt(() => request('PUT', `/api/albums/${albumId}`, { title: album.title, description: album.description, coverAssetId: first }), '已设为封面');
    if (!ok) return;
    selection.stop();
    await refresh();
  }

  function remove() {
    ask({
      title: '删除相册',
      message: `删除相册“${album.title}”？只删除相册，照片本身不受影响；这个相册的分享链接也会失效。`,
      confirmLabel: '删除',
      danger: true,
      action: async () => {
        await request('DELETE', `/api/albums/${albumId}`);
        // 只标记过期、不马上重新加载：不然这个页面还没离开，会去加载已经删掉的相册，闪一下出错。相册列表打开时会重新加载
        await queryClient.invalidateQueries({ queryKey: ['/api', 'albums'], refetchType: 'none' });
        navigate('/albums');
      },
    });
  }

  return (
    <>
      <div className="section-actions">
        <div>
          <p className="muted small">
            <Link to="/albums">相册</Link> /
          </p>
          <h1>{album.title}</h1>
          {album.description && <p className="muted">{album.description}</p>}
          <p className="muted small">
            {items.length} 张{items.length > 0 && ` · ${formatDate(items[0].takenAt)} – ${formatDate(items.at(-1)!.takenAt)}`}
          </p>
        </div>
        <div className="actions-row">
          {items.length > 0 && (
            <button className="btn" onClick={() => setPlaying(true)}>
              <Play size={16} fill="currentColor" />
              播放
            </button>
          )}
          {editable && (
            <>
              <button className="btn" onClick={() => setSharing(true)}>
                <Share2 size={16} />
                分享
              </button>
              <button className="icon-btn" onClick={() => setEditing(true)} aria-label="修改相册">
                <Pencil size={18} />
              </button>
              <button className="icon-btn" onClick={remove} aria-label="删除相册">
                <Trash2 size={18} />
              </button>
            </>
          )}
        </div>
      </div>
      {editable && items.length > 0 && (
        <div className="selection-tools">
          {selection.selected ? (
            <>
              <span className="muted">已选 {selection.selected.size} 张</span>
              <button className="btn btn-small" disabled={selection.selected.size !== 1} onClick={setCover}>
                <Star size={14} /> 设为封面
              </button>
              <button className="btn btn-small btn-danger-ghost" disabled={!selection.selected.size} onClick={removeSelected}>
                移出相册
              </button>
              <button className="btn btn-small" onClick={selection.stop}>
                完成
              </button>
            </>
          ) : (
            <button className="btn btn-small" onClick={selection.start}>
              选择
            </button>
          )}
        </div>
      )}
      {!items.length ? (
        <Empty icon={<ImagePlus size={40} />} title="相册里还没有照片">
          在照片上点“加入相册”，或者在时间线、全部照片里点“选择”，一次加很多张。
        </Empty>
      ) : (
        <PhotoGrid items={items} onOpen={setOpen} caption={(i) => formatDate(i.takenAt)} selected={selection.selected} onToggle={selection.toggle} />
      )}
      {open !== null && <Lightbox items={items} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />}
      {editing && <AlbumEditor album={album} onClose={() => setEditing(false)} />}
      {confirmDialog}
      {sharing && <ShareEditor share={null} albumId={albumId} defaultLabel={album.title} onClose={() => setSharing(false)} />}
      {playing && (
        <Slideshow
          title={album.title}
          slides={items.filter((i) => i.type === 'IMAGE').map((i) => ({ id: i.id, caption: formatDate(i.takenAt) }))}
          onClose={() => setPlaying(false)}
        />
      )}
    </>
  );
}
