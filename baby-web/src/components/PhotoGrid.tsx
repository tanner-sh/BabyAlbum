import { Heart, Play } from 'lucide-react';
import { thumbUrl, useAlbum, type AlbumItem } from '../api';
import { formatDuration } from '../format';

export function Thumb({ item, onClick, caption }: { item: AlbumItem; onClick: () => void; caption?: string }) {
  const album = useAlbum();
  return (
    <button className="thumb" onClick={onClick} aria-label={`${item.age.label} ${item.fileName}`}>
      <img src={thumbUrl(album, item.id)} alt="" loading="lazy" decoding="async" />
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
