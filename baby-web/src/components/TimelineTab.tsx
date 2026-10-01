import { Flag, ImageOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMilestones, useTimeline, type AlbumItem, type Baby, type TimelineGroup } from '../api';
import { ageMonths } from '../format';
import { Lightbox } from './Lightbox';
import { PhotoGrid } from './PhotoGrid';
import { Empty, ErrorBox, Spinner } from './ui';

export function TimelineTab({ baby, onMilestone }: { baby: Baby; onMilestone?: (item: AlbumItem) => void }) {
  const timeline = useTimeline(baby.id);
  const milestones = useMilestones(baby.id);
  const [open, setOpen] = useState<number | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  // 相邻两页的边界可能落在同一个月龄里，合并同名分组
  const { groups, flat } = useMemo(() => {
    const groups: (TimelineGroup & { offset: number })[] = [];
    const flat: AlbumItem[] = [];
    for (const page of timeline.data?.pages ?? []) {
      for (const g of page.groups) {
        const last = groups.at(-1);
        if (last && last.label === g.label) last.items = [...last.items, ...g.items];
        else groups.push({ ...g, offset: flat.length });
        flat.push(...g.items);
      }
    }
    return { groups, flat };
  }, [timeline.data]);

  const milestonesByMonth = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const m of milestones.data ?? []) {
      const months = ageMonths(baby.birthday, m.date);
      map.set(months, [...(map.get(months) ?? []), m.title]);
    }
    return map;
  }, [milestones.data, baby.birthday]);

  // 滚动到底部时加载下一页
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = timeline;
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => entries[0].isIntersecting && hasNextPage && !isFetchingNextPage && fetchNextPage(),
      { rootMargin: '800px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (timeline.isPending) return <Spinner />;
  if (timeline.isError) return <ErrorBox error={timeline.error} />;
  if (!flat.length) {
    return (
      <Empty icon={<ImageOff size={40} />} title="还没有照片">
        Immich 还没识别出有{baby.name}的照片。人脸识别需要一些时间，也可以在 Immich 中手动标注。
      </Empty>
    );
  }

  return (
    <>
      {groups.map((g) => (
        <section key={g.label} className="group">
          <header className="group-header">
            <h3>{g.label}</h3>
            <span className="muted">{g.items.length} 张</span>
            {(milestonesByMonth.get(g.months) ?? []).map((title) => (
              <span key={title} className="chip chip-accent">
                <Flag size={12} />
                {title}
              </span>
            ))}
          </header>
          <PhotoGrid items={g.items} onOpen={(i) => setOpen(g.offset + i)} />
        </section>
      ))}
      <div ref={sentinel} />
      {isFetchingNextPage && <Spinner />}
      {!hasNextPage && flat.length > 30 && <p className="end-note">到底啦，这是{baby.name}最早的照片</p>}
      {open !== null && (
        <Lightbox
          items={flat}
          index={open}
          onIndexChange={(i) => {
            setOpen(i);
            // 快看到已加载的末尾时，提前加载下一页
            if (i > flat.length - 10 && hasNextPage && !isFetchingNextPage) fetchNextPage();
          }}
          onClose={() => setOpen(null)}
          onMilestone={onMilestone}
        />
      )}
    </>
  );
}
