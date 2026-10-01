import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router';
import { useBabies } from '../api';
import { PhotosTabs } from '../components/SectionTabs';
import { Spinner } from '../components/ui';

// 地图库比较大，用到时才加载
const MapView = lazy(() => import('../components/MapView'));

/** 地图：按拍摄地点看照片 */
export function MapPage() {
  const [params, setParams] = useSearchParams();
  const babies = useBabies();
  const babyId = params.get('baby') ? Number(params.get('baby')) : null;
  return (
    <>
      <PhotosTabs />
      {(babies.data?.length ?? 0) > 0 && (
        <div className="chips search-scope">
          <button className={`chip ${babyId === null ? 'chip-accent' : ''}`} onClick={() => setParams({}, { replace: true })}>
            全部
          </button>
          {babies.data!.map((b) => (
            <button key={b.id} className={`chip ${babyId === b.id ? 'chip-accent' : ''}`} onClick={() => setParams({ baby: String(b.id) }, { replace: true })}>
              有{b.name}的
            </button>
          ))}
        </div>
      )}
      <Suspense fallback={<Spinner label="正在加载地图…" />}>
        <MapView key={babyId ?? 'all'} babyId={babyId} />
      </Suspense>
    </>
  );
}
