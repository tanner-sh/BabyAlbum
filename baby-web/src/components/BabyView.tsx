import { CalendarHeart, Flag, Images, Sprout } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAlbum, type Baby } from '../api';
import { GrowthTab } from './GrowthTab';
import { MemoriesTab } from './MemoriesTab';
import { MilestoneEditor, MilestonesTab, type MilestoneDraft } from './MilestonesTab';
import { TimelineTab } from './TimelineTab';
import { Tabs } from './ui';

type Tab = 'timeline' | 'growth' | 'memories' | 'milestones';
const TABS: { value: Tab; label: string; icon: React.ReactNode }[] = [
  { value: 'timeline', label: '时间线', icon: <Images size={16} /> },
  { value: 'growth', label: '成长墙', icon: <Sprout size={16} /> },
  { value: 'memories', label: '那年今日', icon: <CalendarHeart size={16} /> },
  { value: 'milestones', label: '里程碑', icon: <Flag size={16} /> },
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
              p.set('tab', t);
              return p;
            },
            { replace: true },
          )
        }
        options={TABS}
      />
      <div className="tab-panel">
        {tab === 'timeline' && <TimelineTab key={baby.id} baby={baby} onMilestone={onMilestone} />}
        {tab === 'growth' && <GrowthTab key={baby.id} baby={baby} onMilestone={onMilestone} />}
        {tab === 'memories' && <MemoriesTab key={baby.id} baby={baby} onMilestone={onMilestone} />}
        {tab === 'milestones' && <MilestonesTab key={baby.id} baby={baby} onEdit={album.readOnly ? undefined : setDraft} />}
      </div>
      {draft && <MilestoneEditor baby={baby} draft={draft} onClose={() => setDraft(null)} />}
    </>
  );
}
