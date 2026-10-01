import { Flag, ImageOff, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAlbum, useCompanions, useMilestones, useTimeline, type AlbumItem, type Baby, type TimelineGroup } from '../api';
import { ageMonths } from '../format';
import { Lightbox } from './Lightbox';
import { PhotoGrid } from './PhotoGrid';
import { SelectionBar, useSelection } from './AlbumPicker';
import { Avatar, Empty, ErrorBox, Spinner } from './ui';

export function TimelineTab({ baby, onMilestone }: { baby: Baby; onMilestone?: (item: AlbumItem) => void }) {
  const album = useAlbum();
  const [withWho, setWithWho] = useState<string | null>(null);
  const timeline = useTimeline(baby.id, withWho);
  const selection = useSelection();
  const canSelect = !album.readOnly && album.base === '/api';
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

  const filter = (
    <div className="timeline-tools">
      <CompanionFilter baby={baby} value={withWho} onChange={setWithWho} />
      {canSelect && !selection.selected && (
        <button className="btn btn-small select-btn" onClick={selection.start}>
          选择
        </button>
      )}
    </div>
  );
  if (timeline.isPending) return (
    <>
      {filter}
      <Spinner />
    </>
  );
  if (timeline.isError) return <ErrorBox error={timeline.error} />;
  if (!flat.length && withWho) {
    return (
      <>
        {filter}
        <Empty icon={<Users size={40} />} title={withWho === 'family' ? '还没找到全家福' : '还没有合照'}>
          {withWho === 'family' ? `全家福是${baby.name}和至少两位已命名的家人一起出现的照片。` : '照片还在导入和识别，过一阵再来看看。'}
        </Empty>
      </>
    );
  }
  if (!flat.length) {
    return (
      <Empty icon={<ImageOff size={40} />} title="还没有照片">
        Immich 还没识别出有{baby.name}的照片。人脸识别需要一些时间，也可以在 Immich 中手动标注。
      </Empty>
    );
  }

  return (
    <>
      {filter}
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
          <PhotoGrid items={g.items} onOpen={(i) => setOpen(g.offset + i)} selected={selection.selected} onToggle={selection.toggle} />
        </section>
      ))}
      {selection.selected && <SelectionBar selected={selection.selected} onClear={selection.stop} />}
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

/** 和谁在一起：已命名、和宝宝同框过的家人，以及全家福 */
function CompanionFilter({ baby, value, onChange }: { baby: Baby; value: string | null; onChange: (v: string | null) => void }) {
  const album = useAlbum();
  // 分享链接里不显示家人（接口也只返回空列表）
  const companions = useCompanions(album.base === '/api' ? baby.id : -1);
  // 还没给家人命名时不显示
  const list = album.base === '/api' ? (companions.data ?? []) : [];
  if (!list.length) return null;
  return (
    <div className="companions" role="group" aria-label="和谁在一起">
      <span className="muted">和谁在一起</span>
      <button className={`chip ${value === null ? 'chip-accent' : ''}`} onClick={() => onChange(null)}>
        全部
      </button>
      {list.map((p) => (
        <button key={p.id} className={`chip companion ${value === p.id ? 'chip-accent' : ''}`} onClick={() => onChange(value === p.id ? null : p.id)}>
          <Avatar baby={{ name: p.name, thumbnailUrl: p.thumbnailUrl }} size={22} />
          {p.name}
          <span className="muted">{p.count.toLocaleString()}</span>
        </button>
      ))}
      {list.length >= 2 && (
        <button className={`chip ${value === 'family' ? 'chip-accent' : ''}`} onClick={() => onChange(value === 'family' ? null : 'family')}>
          <Users size={14} />
          全家福
        </button>
      )}
    </div>
  );
}
