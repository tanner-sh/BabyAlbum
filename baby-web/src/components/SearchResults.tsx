import { SearchX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAlbum, useSearch, type AlbumItem } from '../api';
import { SelectionBar, useSelection } from './AlbumPicker';
import { formatDate } from '../format';
import { Lightbox } from './Lightbox';
import { PhotoGrid } from './PhotoGrid';
import { Empty, ErrorBox, Spinner } from './ui';

export const SEARCH_EXAMPLES = ['在海边', '吃蛋糕', '哭', '睡觉', '洗澡', '过生日', '下雪', '游泳', '荡秋千', '和小狗'];

/** 语义搜索的结果：按相关程度排序，滚动到底自动加载更多 */
export function SearchResults({ q, babyId, onMilestone }: { q: string; babyId: number | null; onMilestone?: (item: AlbumItem) => void }) {
  const album = useAlbum();
  const search = useSearch(q, babyId);
  const selection = useSelection();
  const [open, setOpen] = useState<number | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const items = useMemo(() => {
    // 不同页之间可能有重复，去重
    const seen = new Set<string>();
    return (search.data?.pages ?? []).flatMap((p) => p.items).filter((i) => !seen.has(i.id) && seen.add(i.id));
  }, [search.data]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = search;
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => entries[0].isIntersecting && hasNextPage && !isFetchingNextPage && fetchNextPage(), { rootMargin: '600px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (!q.trim()) return null;
  if (search.isPending) return <Spinner label="正在搜索…" />;
  if (search.isError) return <ErrorBox error={search.error} />;
  if (!items.length) {
    return (
      <Empty icon={<SearchX size={40} />} title="没有找到">
        换个说法试试，比如“在海边”“吃蛋糕”。照片要先建好语义搜索索引才能搜到。
      </Empty>
    );
  }
  return (
    <>
      <div className="timeline-tools">
        <p className="muted small">按相关程度排序，越靠前越像“{q}”</p>
        {!album.readOnly && album.base === '/api' && !selection.selected && (
          <button className="btn btn-small select-btn" onClick={selection.start}>
            选择
          </button>
        )}
      </div>
      <PhotoGrid items={items} onOpen={setOpen} caption={(i) => i.age?.label ?? formatDate(i.takenAt)} selected={selection.selected} onToggle={selection.toggle} />
      {selection.selected && <SelectionBar selected={selection.selected} onClear={selection.stop} />}
      <div ref={sentinel} />
      {isFetchingNextPage && <Spinner />}
      {open !== null && (
        <Lightbox
          items={items}
          index={open}
          onIndexChange={(i) => {
            setOpen(i);
            if (i > items.length - 10 && hasNextPage && !isFetchingNextPage) fetchNextPage();
          }}
          onClose={() => setOpen(null)}
          onMilestone={onMilestone}
        />
      )}
    </>
  );
}

/** 搜索框：回车或点示例才搜索 */
export function SearchBox({ value, onSearch, autoFocus }: { value: string; onSearch: (q: string) => void; autoFocus?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="search-box">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSearch(text.trim());
        }}
      >
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="用一句话找照片，比如：在海边、吃蛋糕" autoFocus={autoFocus} enterKeyHint="search" />
        <button className="btn btn-primary" disabled={!text.trim()}>
          搜索
        </button>
      </form>
      <div className="chips">
        {SEARCH_EXAMPLES.map((ex) => (
          <button key={ex} type="button" className={`chip ${value === ex ? 'chip-accent' : ''}`} onClick={() => onSearch(ex)}>
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}
