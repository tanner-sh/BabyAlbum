import { Pause, Play, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { thumbUrl, useAlbum, type GrowthCell } from '../api';

const INTERVAL_MS = 2500;

/** 成长播放：按月龄依次展示每个月的代表照片 */
export function Slideshow({ title, cells, onClose }: { title: string; cells: GrowthCell[]; onClose: () => void }) {
  const album = useAlbum();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const cell = cells[index];

  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => {
      if (index < cells.length - 1) setIndex(index + 1);
      else setPaused(true);
    }, INTERVAL_MS);
    return () => clearTimeout(t);
  }, [index, paused, cells.length]);

  // 预加载下一张
  useEffect(() => {
    const next = cells[index + 1]?.cover;
    if (next) new Image().src = thumbUrl(album, next.id, 'preview');
  }, [index, cells, album]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === ' ') setPaused((p) => !p);
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, cells.length - 1));
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [onClose, cells.length]);

  return (
    <div className="slideshow">
      <img key={cell.cover!.id} className="slideshow-img" src={thumbUrl(album, cell.cover!.id, 'preview')} alt="" />
      <div className="slideshow-caption">
        <span>{title}</span>
        <strong>{cell.label}</strong>
      </div>
      <div className="slideshow-controls">
        <button
          className="icon-btn light"
          onClick={() => {
            if (paused && index === cells.length - 1) setIndex(0);
            setPaused((p) => !p);
          }}
          aria-label={paused ? '播放' : '暂停'}
        >
          {paused ? <Play size={22} fill="currentColor" /> : <Pause size={22} fill="currentColor" />}
        </button>
        <input
          type="range"
          min={0}
          max={cells.length - 1}
          value={index}
          onChange={(e) => setIndex(Number(e.target.value))}
          aria-label="进度"
        />
        <button className="icon-btn light" onClick={onClose} aria-label="关闭">
          <X size={22} />
        </button>
      </div>
    </div>
  );
}
