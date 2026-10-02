import { Images } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useOutletContext } from 'react-router';
import { canSeeAllPhotos, usePhotos, type AlbumItem, type Me } from '../api';
import { Lightbox } from '../components/Lightbox';
import { SelectionBar, useSelection } from '../components/AlbumPicker';
import { PhotoGrid } from '../components/PhotoGrid';
import { PhotosTabs } from '../components/SectionTabs';
import { Empty, ErrorBox, Spinner } from '../components/ui';

/** 全部照片：照片库里的所有照片和视频，按月份分组。导入时处理到哪就显示到哪 */
export function PhotosPage() {
  const me = useOutletContext<Me>();
  if (!canSeeAllPhotos(me)) return <Navigate to="/" replace />;
  return <AllPhotos isAdmin={me.role === 'admin'} />;
}

function AllPhotos({ isAdmin }: { isAdmin: boolean }) {
  const photos = usePhotos();
  const selection = useSelection();
  const [open, setOpen] = useState<number | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  // 相邻两页可能落在同一个月里，合并同名分组
  const { groups, flat } = useMemo(() => {
    const groups: { label: string; items: AlbumItem[]; offset: number }[] = [];
    const flat: AlbumItem[] = [];
    for (const page of photos.data?.pages ?? []) {
      for (const g of page.groups) {
        const last = groups.at(-1);
        if (last && last.label === g.label) last.items = [...last.items, ...g.items];
        else groups.push({ ...g, offset: flat.length });
        flat.push(...g.items);
      }
    }
    return { groups, flat };
  }, [photos.data]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = photos;
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => entries[0].isIntersecting && hasNextPage && !isFetchingNextPage && fetchNextPage(), {
      rootMargin: '800px',
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (photos.isPending) return <Spinner />;
  if (photos.isError) return <ErrorBox error={photos.error} />;

  return (
    <>
      <PhotosTabs />
      <div className="section-actions">
        <p className="muted">
          照片库里的所有照片和视频，导入时处理好一张出现一张
          {isAdmin && (
            <>
              （<Link to="/admin/library">导入进度</Link>）
            </>
          )}
        </p>
        {!selection.selected && (
          <button className="btn btn-small" onClick={selection.start}>
            选择
          </button>
        )}
      </div>
      {!flat.length ? (
        <Empty icon={<Images size={40} />} title="还没有照片">
          照片还在导入，读完拍摄信息后会陆续出现在这里。
        </Empty>
      ) : (
        groups.map((g) => (
          <section key={g.label} className="group">
            <header className="group-header">
              <h3>{g.label}</h3>
              <span className="muted">{g.items.length} 张</span>
            </header>
            <PhotoGrid items={g.items} onOpen={(i) => setOpen(g.offset + i)} selected={selection.selected} onToggle={selection.toggle} />
          </section>
        ))
      )}
      <div ref={sentinel} />
      {selection.selected && <SelectionBar selected={selection.selected} onClear={selection.stop} />}
      {isFetchingNextPage && <Spinner />}
      {open !== null && (
        <Lightbox
          items={flat}
          index={open}
          onIndexChange={(i) => {
            setOpen(i);
            if (i > flat.length - 10 && hasNextPage && !isFetchingNextPage) fetchNextPage();
          }}
          onClose={() => setOpen(null)}
          hasMore={hasNextPage}
        />
      )}
    </>
  );
}
