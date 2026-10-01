import { Play, Sprout } from 'lucide-react';
import { useState } from 'react';
import { thumbUrl, useAlbum, useGrowth, useMonth, type AlbumItem, type Baby, type GrowthCell } from '../api';
import { formatDate } from '../format';
import { Lightbox } from './Lightbox';
import { PhotoGrid } from './PhotoGrid';
import { Slideshow } from './Slideshow';
import { Empty, ErrorBox, Modal, Spinner } from './ui';

/** 成长墙：每个月龄一张代表照片（优先收藏的），可以连起来播放 */
export function GrowthTab({ baby, onMilestone }: { baby: Baby; onMilestone?: (item: AlbumItem) => void }) {
  const album = useAlbum();
  const growth = useGrowth(baby.id);
  const [month, setMonth] = useState<GrowthCell | null>(null);
  const [playing, setPlaying] = useState(false);

  if (growth.isPending) return <Spinner label="正在挑选每个月的照片…" />;
  if (growth.isError) return <ErrorBox error={growth.error} />;
  const withCover = growth.data.filter((c) => c.cover);
  if (!withCover.length) return <Empty icon={<Sprout size={40} />} title="还没有照片" />;

  return (
    <>
      <div className="section-actions">
        <p className="muted">每个月选一张：优先选收藏的照片。在照片上点 ♥ 可以换成你最喜欢的那张。</p>
        <button className="btn btn-primary" onClick={() => setPlaying(true)}>
          <Play size={16} fill="currentColor" />
          播放成长
        </button>
      </div>
      <div className="growth-grid">
        {growth.data.map((cell) => (
          <button key={cell.months} className="growth-cell" disabled={!cell.cover} onClick={() => setMonth(cell)}>
            {cell.cover ? <img src={thumbUrl(album, cell.cover.id)} alt="" loading="lazy" /> : <span className="growth-empty">这个月没有照片</span>}
            <span className="growth-label">{cell.label}</span>
          </button>
        ))}
      </div>
      {month && <MonthSheet baby={baby} cell={month} onClose={() => setMonth(null)} onMilestone={onMilestone} />}
      {playing && <Slideshow title={`${baby.name}的成长`} cells={withCover} onClose={() => setPlaying(false)} />}
    </>
  );
}

function MonthSheet({
  baby,
  cell,
  onClose,
  onMilestone,
}: {
  baby: Baby;
  cell: GrowthCell;
  onClose: () => void;
  onMilestone?: (item: AlbumItem) => void;
}) {
  const month = useMonth(baby.id, cell.months);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Modal title={`${baby.name} · ${cell.label}`} onClose={onClose} wide>
      <p className="muted">从 {formatDate(cell.from)} 起的一个月</p>
      {month.isPending ? (
        <Spinner />
      ) : month.isError ? (
        <ErrorBox error={month.error} />
      ) : (
        <PhotoGrid items={month.data.items} onOpen={setOpen} caption={(i) => i.age?.label ?? ''} />
      )}
      {open !== null && month.data && (
        <Lightbox items={month.data.items} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} onMilestone={onMilestone} />
      )}
    </Modal>
  );
}
