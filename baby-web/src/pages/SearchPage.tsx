import { useSearchParams } from 'react-router';
import { useBabies } from '../api';
import { SearchBox, SearchResults } from '../components/SearchResults';

/** 语义搜索：用一句话找照片，由照片服务的 AI 模型理解照片内容 */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const babies = useBabies();
  const q = params.get('q') ?? '';
  const babyId = params.get('baby') ? Number(params.get('baby')) : null;

  const update = (next: { q?: string; baby?: number | null }) =>
    setParams((p) => {
      if (next.q !== undefined) p.set('q', next.q);
      if (next.baby !== undefined) {
        if (next.baby === null) p.delete('baby');
        else p.set('baby', String(next.baby));
      }
      return p;
    });

  return (
    <>
      <h1>搜索</h1>
      <SearchBox value={q} onSearch={(text) => update({ q: text })} autoFocus={!q} />
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
      <SearchResults q={q} babyId={babyId} />
    </>
  );
}
