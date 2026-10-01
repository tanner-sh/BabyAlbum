import { Map as MapIcon, Search } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router';
import { useBabies } from '../api';
import { SearchBox, SearchResults } from '../components/SearchResults';
import { Spinner, Tabs } from '../components/ui';

// 地图库比较大，用到时才加载
const MapView = lazy(() => import('../components/MapView'));

/** 找照片：用一句话搜（照片服务的 AI 模型理解照片内容），或者在地图上按拍摄地点看 */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const babies = useBabies();
  const q = params.get('q') ?? '';
  const babyId = params.get('baby') ? Number(params.get('baby')) : null;
  const mode = params.get('mode') === 'map' ? 'map' : 'text';

  const update = (next: { q?: string; baby?: number | null; mode?: 'text' | 'map' }) =>
    setParams((p) => {
      if (next.mode !== undefined) p.set('mode', next.mode);
      if (next.q !== undefined) p.set('q', next.q);
      if (next.baby !== undefined) {
        if (next.baby === null) p.delete('baby');
        else p.set('baby', String(next.baby));
      }
      return p;
    });

  return (
    <>
      <Tabs
        value={mode}
        onChange={(m) => update({ mode: m })}
        options={[
          { value: 'text', label: '按内容搜', icon: <Search size={16} /> },
          { value: 'map', label: '地图', icon: <MapIcon size={16} /> },
        ]}
      />
      {mode === 'text' && <SearchBox value={q} onSearch={(text) => update({ q: text })} autoFocus={!q} />}
      {(babies.data?.length ?? 0) > 0 && (
        <div className="chips search-scope">
          <span className="muted">范围</span>
          <button className={`chip ${babyId === null ? 'chip-accent' : ''}`} onClick={() => update({ baby: null })}>
            全部
          </button>
          {babies.data!.map((b) => (
            <button key={b.id} className={`chip ${babyId === b.id ? 'chip-accent' : ''}`} onClick={() => update({ baby: b.id })}>
              有{b.name}的
            </button>
          ))}
        </div>
      )}
      {mode === 'text' ? (
        <SearchResults q={q} babyId={babyId} />
      ) : (
        <Suspense fallback={<Spinner label="正在加载地图…" />}>
          <MapView key={babyId ?? 'all'} babyId={babyId} />
        </Suspense>
      )}
    </>
  );
}
