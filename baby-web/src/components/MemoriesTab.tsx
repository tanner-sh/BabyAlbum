import { CalendarHeart } from 'lucide-react';
import { useState } from 'react';
import { useOnThisDay, type AlbumItem, type Baby } from '../api';
import { formatDate } from '../format';
import { Lightbox } from './Lightbox';
import { PhotoGrid } from './PhotoGrid';
import { Empty, ErrorBox, Spinner } from './ui';

/** 那年今日：往年同一天的照片 */
export function MemoriesTab({ baby, onMilestone }: { baby: Baby; onMilestone?: (item: AlbumItem) => void }) {
  const memories = useOnThisDay(baby.id);
  const [open, setOpen] = useState<{ items: AlbumItem[]; index: number } | null>(null);

  if (memories.isPending) return <Spinner />;
  if (memories.isError) return <ErrorBox error={memories.error} />;
  if (!memories.data.length) {
    return (
      <Empty icon={<CalendarHeart size={40} />} title="往年的今天没有照片">
        明天再来看看吧。
      </Empty>
    );
  }

  return (
    <>
      {memories.data.map((entry) => (
        <section key={entry.year} className="group">
          <header className="group-header">
            <h3>{entry.yearsAgo} 年前的今天</h3>
            <span className="muted">
              {formatDate(entry.date)} · {baby.name}
              {entry.ageLabel}
            </span>
          </header>
          <PhotoGrid items={entry.items} onOpen={(index) => setOpen({ items: entry.items, index })} />
        </section>
      ))}
      {open && (
        <Lightbox
          items={open.items}
          index={open.index}
          onIndexChange={(index) => setOpen({ ...open, index })}
          onClose={() => setOpen(null)}
          onMilestone={onMilestone}
        />
      )}
    </>
  );
}
