import { CalendarHeart, Columns2, Flag, Images, NotebookPen, Ruler, Sparkles, Sprout } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useAlbum, useBabies, type Baby } from '../api';
import { CompareView } from '../pages/ComparePage';
import { GrowthTab } from './GrowthTab';
import { JournalTab } from './JournalTab';
import { MeasurementsTab } from './MeasurementsTab';
import { MemoriesTab } from './MemoriesTab';
import { MilestoneEditor, MilestonesTab, type MilestoneDraft } from './MilestonesTab';
import { ReviewTab } from './ReviewTab';
import { TimelineTab } from './TimelineTab';
import { Tabs } from './ui';

// 宝宝页只有 3 个标签，“回顾”“记录”里面再用小的切换按钮分开
type Tab = 'photos' | 'review' | 'records';
type View = 'highlights' | 'growth' | 'memories' | 'compare' | 'milestones' | 'journal' | 'measurements';

const TABS: { value: Tab; label: string; icon: ReactNode }[] = [
  { value: 'photos', label: '照片', icon: <Images size={16} /> },
  { value: 'review', label: '回顾', icon: <Sparkles size={16} /> },
  { value: 'records', label: '记录', icon: <NotebookPen size={16} /> },
];

const VIEWS: Record<Exclude<Tab, 'photos'>, { value: View; label: string; icon: ReactNode }[]> = {
  review: [
    { value: 'highlights', label: '精选', icon: <Sparkles size={14} /> },
    { value: 'growth', label: '成长墙', icon: <Sprout size={14} /> },
    { value: 'memories', label: '那年今日', icon: <CalendarHeart size={14} /> },
    { value: 'compare', label: '同龄对比', icon: <Columns2 size={14} /> },
  ],
  records: [
    { value: 'milestones', label: '里程碑', icon: <Flag size={14} /> },
    { value: 'journal', label: '日记', icon: <NotebookPen size={14} /> },
    { value: 'measurements', label: '成长数据', icon: <Ruler size={14} /> },
  ],
};

/** 以前的地址（推送通知、收藏的链接）里是 7 个标签之一，换成现在的标签 + 页内切换 */
const LEGACY: Record<string, [Tab, View | null]> = {
  timeline: ['photos', null],
  growth: ['review', 'growth'],
  memories: ['review', 'memories'],
  milestones: ['records', 'milestones'],
  journal: ['records', 'journal'],
  measurements: ['records', 'measurements'],
};

/** 一个宝宝的相册：登录页面和分享页面共用，分享页面（readOnly）不能编辑。photosExtra：只在“照片”标签上方显示的提示 */
export function BabyView({ baby, photosExtra }: { baby: Baby; photosExtra?: ReactNode }) {
  const album = useAlbum();
  const babies = useBabies(album.base === '/api');
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<MilestoneDraft | null>(null);

  const raw = params.get('tab') ?? 'photos';
  const [tab, legacyView] = LEGACY[raw] ?? [(TABS.some((t) => t.value === raw) ? raw : 'photos') as Tab, null];
  // 同龄对比要两个以上的宝宝，分享链接里没有
  const views = tab === 'photos' ? [] : VIEWS[tab].filter((v) => v.value !== 'compare' || (album.base === '/api' && (babies.data?.length ?? 0) >= 2));
  const view = (views.find((v) => v.value === (params.get('view') ?? legacyView))?.value ?? views[0]?.value ?? null) as View | null;

  // 切换标签时记住每个标签滚到哪了；时间线切走后不卸载，回来还在原来的位置
  const key = `${tab}:${view ?? ''}`;
  const scrolls = useRef(new Map<string, number>());
  const tabsRef = useRef<HTMLDivElement>(null);
  const [photosMounted, setPhotosMounted] = useState(tab === 'photos');
  if (tab === 'photos' && !photosMounted) setPhotosMounted(true);
  const lastKey = useRef(key);
  useLayoutEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    const saved = scrolls.current.get(key);
    // 没来过的标签：从标签栏开始看
    const tabsTop = (tabsRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY - 64;
    window.scrollTo(0, saved ?? Math.min(window.scrollY, Math.max(0, tabsTop)));
  }, [key]);

  const go = (next: { tab: Tab; view?: View }) => {
    scrolls.current.set(key, window.scrollY);
    setParams(
      (p) => {
        // 换标签时去掉回顾、对比的选择（kind、index、m）
        const keep = new URLSearchParams();
        for (const [k, v] of p) if (!['tab', 'view', 'kind', 'index', 'm'].includes(k)) keep.set(k, v);
        keep.set('tab', next.tab);
        if (next.view) keep.set('view', next.view);
        return keep;
      },
      { replace: true },
    );
  };

  const onMilestone = album.readOnly
    ? undefined
    : (item: { id: string; takenAt: string }) => setDraft({ date: item.takenAt.slice(0, 10), coverAssetId: item.id });

  return (
    <>
      {/* 标签栏是吸顶的，不能包在别的元素里；用一个空元素记下它原来的位置 */}
      <div ref={tabsRef} />
      <Tabs value={tab} onChange={(t) => go({ tab: t })} options={TABS} />
      <div className="tab-panel">
        {views.length > 1 && (
          <div className="subtabs" role="tablist">
            {views.map((v) => (
              <button key={v.value} role="tab" aria-selected={view === v.value} className={`subtab ${view === v.value ? 'active' : ''}`} onClick={() => go({ tab, view: v.value })}>
                {v.icon}
                {v.label}
              </button>
            ))}
          </div>
        )}
        {photosMounted && (
          <div hidden={tab !== 'photos'}>
            {photosExtra}
            <TimelineTab key={baby.id} baby={baby} onMilestone={onMilestone} />
          </div>
        )}
        {view === 'highlights' && <ReviewTab key={baby.id} baby={baby} onMilestone={onMilestone} />}
        {view === 'growth' && <GrowthTab key={baby.id} baby={baby} onMilestone={onMilestone} />}
        {view === 'memories' && <MemoriesTab key={baby.id} baby={baby} onMilestone={onMilestone} />}
        {view === 'compare' && <CompareView />}
        {view === 'milestones' && <MilestonesTab key={baby.id} baby={baby} onEdit={album.readOnly ? undefined : setDraft} />}
        {view === 'journal' && <JournalTab key={baby.id} baby={baby} onMilestone={onMilestone} />}
        {view === 'measurements' && <MeasurementsTab key={baby.id} baby={baby} />}
      </div>
      {draft && <MilestoneEditor baby={baby} draft={draft} onClose={() => setDraft(null)} />}
    </>
  );
}
