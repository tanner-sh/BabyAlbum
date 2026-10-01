import { Heart, Hourglass, Play } from 'lucide-react';
import { useState } from 'react';
import { thumbUrl, useAlbum, type AlbumItem } from '../api';
import { formatDuration } from '../format';

/** 实况照片的标记（同心圆，和手机相册里的一样） */
export function LiveBadge({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="10" strokeDasharray="2 2.6" />
    </svg>
  );
}

export function Thumb({ item, onClick, caption }: { item: AlbumItem; onClick: () => void; caption?: string }) {
  const album = useAlbum();
  // 刚导入的照片可能还没生成缩略图
  const [missing, setMissing] = useState(false);
  return (
    <button className="thumb" onClick={onClick} aria-label={`${item.age?.label ?? ''} ${item.fileName}`}>
      {missing ? (
        <span className="thumb-pending">
          <Hourglass size={18} />
          处理中
        </span>
      ) : (
        <img src={thumbUrl(album, item.id)} alt="" loading="lazy" decoding="async" onError={() => setMissing(true)} />
      )}
      {item.livePhotoVideoId && (
        <span className="thumb-badge thumb-live" title="实况照片">
          <LiveBadge size={12} />
        </span>
      )}
      {item.type === 'VIDEO' && (
        <span className="thumb-badge">
          <Play size={12} fill="currentColor" />
          {formatDuration(item.duration)}
        </span>
      )}
      {item.isFavorite && <Heart className="thumb-fav" size={16} fill="currentColor" />}
      {caption && <span className="thumb-caption">{caption}</span>}
    </button>
  );
}

export function PhotoGrid({
  items,
  onOpen,
  caption,
}: {
  items: AlbumItem[];
  onOpen: (index: number) => void;
  caption?: (item: AlbumItem) => string;
}) {
  return (
    <div className="grid">
      {items.map((item, i) => (
        <Thumb key={item.id + i} item={item} onClick={() => onOpen(i)} caption={caption?.(item)} />
      ))}
    </div>
  );
}
