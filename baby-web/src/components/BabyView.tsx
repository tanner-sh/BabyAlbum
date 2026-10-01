import { CalendarHeart, Flag, Images, NotebookPen, Ruler, Sparkles, Sprout } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAlbum, type Baby } from '../api';
import { GrowthTab } from './GrowthTab';
import { JournalTab } from './JournalTab';
import { MeasurementsTab } from './MeasurementsTab';
import { MemoriesTab } from './MemoriesTab';
import { MilestoneEditor, MilestonesTab, type MilestoneDraft } from './MilestonesTab';
import { ReviewTab } from './ReviewTab';
import { TimelineTab } from './TimelineTab';
import { Tabs } from './ui';

type Tab = 'timeline' | 'review' | 'growth' | 'memories' | 'milestones' | 'journal' | 'measurements';
const TABS: { value: Tab; label: string; icon: React.ReactNode }[] = [
  { value: 'timeline', label: '时间线', icon: <Images size={16} /> },
  { value: 'review', label: '回顾', icon: <Sparkles size={16} /> },
  { value: 'growth', label: '成长墙', icon: <Sprout size={16} /> },
  { value: 'memories', label: '那年今日', icon: <CalendarHeart size={16} /> },
  { value: 'milestones', label: '里程碑', icon: <Flag size={16} /> },
  { value: 'journal', label: '日记', icon: <NotebookPen size={16} /> },
  { value: 'measurements', label: '成长数据', icon: <Ruler size={16} /> },
];

/** 一个宝宝的相册：登录页面和分享页面共用，分享页面（readOnly）不能编辑 */
export function BabyView({ baby }: { baby: Baby }) {
  const album = useAlbum();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'timeline') as Tab;
  const [draft, setDraft] = useState<MilestoneDraft | null>(null);

  const onMilestone = album.readOnly
    ? undefined
    : (item: { id: string; takenAt: string }) => setDraft({ date: item.takenAt.slice(0, 10), coverAssetId: item.id });

  return (
    <>
      <Tabs
        value={tab}
        onChange={(t) =>
          setParams(
            (p) => {
              // 换标签时去掉回顾的选择（kind、index）
              const next = new URLSearchParams({ tab: t });
              for (const [k, v] of p) if (!['tab', 'kind', 'index'].includes(k)) next.set(k, v);
              return next;
            },
            { replace: true },
          )
        }
        options={TABS}
      />
      <div className="tab-panel">
        {tab === 'timeline' && <TimelineTab key={baby.id} baby={baby} onMilestone={onMilestone} />}
        {tab === 'review' && <ReviewTab key={baby.id} baby={baby} onMilestone={onMilestone} />}
        {tab === 'growth' && <GrowthTab key={baby.id} baby={baby} onMilestone={onMilestone} />}
        {tab === 'memories' && <MemoriesTab key={baby.id} baby={baby} onMilestone={onMilestone} />}
        {tab === 'milestones' && <MilestonesTab key={baby.id} baby={baby} onEdit={album.readOnly ? undefined : setDraft} />}
        {tab === 'journal' && <JournalTab key={baby.id} baby={baby} onMilestone={onMilestone} />}
        {tab === 'measurements' && <MeasurementsTab key={baby.id} baby={baby} />}
      </div>
      {draft && <MilestoneEditor baby={baby} draft={draft} onClose={() => setDraft(null)} />}
    </>
  );
}
