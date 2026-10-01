import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronLeft, ChevronRight, Download, Flag, Heart, Info, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { originalUrl, request, thumbUrl, useAlbum, useAssetInfo, videoUrl, type AlbumItem } from '../api';
import { formatBytes, formatDateTime } from '../format';
import { EditDateModal } from './DateFix';

type Props = {
  items: AlbumItem[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  /** 只有登录用户才有：把这张照片记为里程碑 */
  onMilestone?: (item: AlbumItem) => void;
};

export function Lightbox({ items, index, onIndexChange, onClose, onMilestone }: Props) {
  const album = useAlbum();
  const queryClient = useQueryClient();
  const item = items[index];
  const [showInfo, setShowInfo] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  // 收藏状态在本地立即更新，不等列表重新加载
  const [favorites, setFavorites] = useState<Record<string, boolean>>({});
  const touchX = useRef<number | null>(null);
  const info = useAssetInfo(showInfo ? item?.id : null);

  const go = (delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < items.length) onIndexChange(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingDate) return;
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  });

  // 预加载相邻的两张
  useEffect(() => {
    for (const i of [index - 1, index + 1]) {
      const it = items[i];
      if (it?.type === 'IMAGE') new Image().src = thumbUrl(album, it.id, 'preview');
    }
  }, [index, items, album]);

  if (!item) return null;
  const isFavorite = favorites[item.id] ?? item.isFavorite;

  async function toggleFavorite() {
    const next = !isFavorite;
    setFavorites((f) => ({ ...f, [item.id]: next }));
    try {
      await request('PUT', `/api/assets/${item.id}/favorite`, { isFavorite: next });
      queryClient.invalidateQueries({ queryKey: [album.base] });
    } catch {
      setFavorites((f) => ({ ...f, [item.id]: !next }));
    }
  }

  return (
    <div
      className="lightbox"
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current === null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        if (Math.abs(dx) > 60) go(dx > 0 ? -1 : 1);
        touchX.current = null;
      }}
    >
      <header className="lightbox-bar">
        <button className="icon-btn light" onClick={onClose} aria-label="关闭">
          <X size={22} />
        </button>
        <div className="lightbox-title">
          <strong>{item.age?.label ?? formatDateTime(item.takenAt, false)}</strong>
          <span>{item.age ? formatDateTime(item.takenAt) : item.fileName}</span>
        </div>
        <div className="lightbox-actions">
          {!album.readOnly && (
            <button className={`icon-btn light ${isFavorite ? 'is-fav' : ''}`} onClick={toggleFavorite} aria-label={isFavorite ? '取消收藏' : '收藏'}>
              <Heart size={20} fill={isFavorite ? 'currentColor' : 'none'} />
            </button>
          )}
          {onMilestone && (
            <button className="icon-btn light" onClick={() => onMilestone(item)} aria-label="记为里程碑" title="记为里程碑">
              <Flag size={20} />
            </button>
          )}
          {!album.readOnly && (
            <button className="icon-btn light" onClick={() => setEditingDate(true)} aria-label="修改日期" title="修改日期">
              <CalendarClock size={20} />
            </button>
          )}
          <a className="icon-btn light" href={originalUrl(album, item.id)} aria-label="下载原图" title="下载原图">
            <Download size={20} />
          </a>
          <button className={`icon-btn light ${showInfo ? 'active' : ''}`} onClick={() => setShowInfo((v) => !v)} aria-label="详细信息">
            <Info size={20} />
          </button>
        </div>
      </header>

      <div className="lightbox-stage">
        {item.type === 'VIDEO' ? (
          <video key={item.id} src={videoUrl(album, item.id)} poster={thumbUrl(album, item.id, 'preview')} controls autoPlay playsInline />
        ) : (
          <img key={item.id} src={thumbUrl(album, item.id, 'preview')} alt={item.fileName} />
        )}
        {index > 0 && (
          <button className="lightbox-nav prev" onClick={() => go(-1)} aria-label="上一张">
            <ChevronLeft size={32} />
          </button>
        )}
        {index < items.length - 1 && (
          <button className="lightbox-nav next" onClick={() => go(1)} aria-label="下一张">
            <ChevronRight size={32} />
          </button>
        )}
      </div>

      {showInfo && (
        <aside className="lightbox-info">
          {info.data ? (
            <dl>
              {info.data.babies.map((b) => (
                <div key={b.id}>
                  <dt>{b.name}</dt>
                  <dd>{b.ageLabel}</dd>
                </div>
              ))}
              <div>
                <dt>拍摄时间</dt>
                <dd>{formatDateTime(info.data.takenAt)}</dd>
              </div>
              {info.data.place && (
                <div>
                  <dt>地点</dt>
                  <dd>{info.data.place}</dd>
                </div>
              )}
              {info.data.camera && (
                <div>
                  <dt>设备</dt>
                  <dd>{info.data.camera}</dd>
                </div>
              )}
              <div>
                <dt>文件</dt>
                <dd>
                  {info.data.fileName}
                  {info.data.width && ` · ${info.data.width}×${info.data.height}`}
                  {info.data.fileSize ? ` · ${formatBytes(info.data.fileSize)}` : ''}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="muted">加载中…</p>
          )}
        </aside>
      )}

      {editingDate && <EditDateModal assetId={item.id} onClose={() => setEditingDate(false)} />}

      <div className="lightbox-counter">
        {index + 1} / {items.length}
      </div>
    </div>
  );
}
