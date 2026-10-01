import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, EyeOff, Star } from 'lucide-react';
import { useState } from 'react';
import { get, request, thumbUrl, useAlbum, type AlbumItem, type DuplicateAsset, type DuplicateGroup, type HiddenAsset } from '../../api';
import { Lightbox } from '../../components/Lightbox';
import { ErrorBox, Spinner } from '../../components/ui';
import { formatBytes, formatDateTime } from '../../format';

const toItem = (a: DuplicateAsset): AlbumItem => ({
  id: a.id,
  type: a.type,
  takenAt: a.takenAt,
  fileName: a.fileName,
  duration: null,
  isFavorite: a.isFavorite,
  width: a.width,
  height: a.height,
  livePhotoVideoId: null,
});

/** 整理：疑似重复的照片（Immich 自动找出的），以及在相册里隐藏了的照片。不会删除存储上的任何文件 */
export function DuplicatesPage() {
  const duplicates = useQuery({ queryKey: ['admin', 'duplicates'], queryFn: () => get<DuplicateGroup[]>('/api/admin/duplicates') });
  const hidden = useQuery({ queryKey: ['admin', 'hidden'], queryFn: () => get<HiddenAsset[]>('/api/admin/hidden') });
  const [limit, setLimit] = useState(20);

  const pending = duplicates.data?.filter((g) => g.assets.filter((a) => !a.hidden).length > 1) ?? [];

  return (
    <div className="admin-page">
      <div className="section-actions">
        <div>
          <h2>
            <Copy size={18} /> 疑似重复的照片
          </h2>
          <p className="muted">
            照片服务自动找出的内容几乎一样的照片（比如同一张照片存了两份、导出过一次）。这里只做提示，<strong>不会删除存储上的任何文件</strong>
            ：可以把多余的在宝宝相册里隐藏（随时能恢复），真要删除请到存储上按路径自己删。
          </p>
        </div>
      </div>
      {duplicates.isPending ? (
        <Spinner />
      ) : duplicates.isError ? (
        <ErrorBox error={duplicates.error} />
      ) : !pending.length ? (
        <div className="empty">
          <p className="empty-title">没有发现重复的照片</p>
          <p>重复检测依赖语义搜索索引，照片导入、建好索引之后才会陆续找出来。</p>
        </div>
      ) : (
        <>
          <p className="muted">还有 {pending.length} 组需要处理</p>
          {pending.slice(0, limit).map((g) => (
            <DuplicateCard key={g.id} group={g} />
          ))}
          {pending.length > limit && (
            <button className="btn" onClick={() => setLimit((l) => l + 20)}>
              再显示 20 组
            </button>
          )}
        </>
      )}

      <section className="hidden-section">
        <h2>
          <EyeOff size={18} /> 在相册里隐藏的照片
        </h2>
        {hidden.isPending ? (
          <Spinner />
        ) : hidden.isError ? (
          <ErrorBox error={hidden.error} />
        ) : !hidden.data.length ? (
          <p className="muted">没有隐藏的照片。</p>
        ) : (
          <HiddenList items={hidden.data} />
        )}
      </section>
    </div>
  );
}

function useRefresh() {
  const queryClient = useQueryClient();
  // 隐藏、恢复会影响所有相册页面
  return () => queryClient.invalidateQueries();
}

function DuplicateCard({ group }: { group: DuplicateGroup }) {
  const album = useAlbum();
  const refresh = useRefresh();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const keep = new Set(group.suggestedKeep.length ? group.suggestedKeep : [group.assets[0].id]);
  const others = group.assets.filter((a) => !keep.has(a.id) && !a.hidden).map((a) => a.id);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card duplicate-card">
      <div className="duplicate-assets">
        {group.assets.map((a, i) => (
          <div key={a.id} className={`duplicate-asset ${a.hidden ? 'is-hidden' : ''}`}>
            <button className="duplicate-thumb" onClick={() => setOpen(i)}>
              <img src={thumbUrl(album, a.id)} alt="" loading="lazy" />
              {keep.has(a.id) && (
                <span className="chip chip-accent">
                  <Star size={12} /> 建议保留
                </span>
              )}
              {a.hidden && <span className="chip">已隐藏</span>}
            </button>
            <div className="duplicate-meta">
              <strong title={a.path}>{a.fileName}</strong>
              <span className="muted">{formatDateTime(a.takenAt)}</span>
              <span className="muted">
                {a.width ? `${a.width}×${a.height}` : ''}
                {a.fileSize ? ` · ${formatBytes(a.fileSize)}` : ''}
              </span>
              <span className="muted path" title={a.path}>
                {a.path}
              </span>
              {a.hidden ? (
                <button className="btn btn-small" disabled={busy} onClick={() => run(() => request('DELETE', `/api/admin/hidden/${a.id}`))}>
                  <Eye size={14} /> 恢复显示
                </button>
              ) : (
                <button className="btn btn-small" disabled={busy} onClick={() => run(() => request('POST', '/api/admin/hidden', { assetIds: [a.id], reason: '重复' }))}>
                  <EyeOff size={14} /> 隐藏
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <footer className="duplicate-actions">
        <button className="btn" disabled={busy} onClick={() => run(() => request('DELETE', `/api/admin/duplicates/${group.id}`))}>
          不是重复
        </button>
        <button className="btn btn-primary" disabled={busy || !others.length} onClick={() => run(() => request('POST', '/api/admin/hidden', { assetIds: others, reason: '重复' }))}>
          只保留建议的，隐藏其余 {others.length} 张
        </button>
      </footer>
      {open !== null && <Lightbox items={group.assets.map(toItem)} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />}
    </article>
  );
}

function HiddenList({ items }: { items: HiddenAsset[] }) {
  const album = useAlbum();
  const refresh = useRefresh();
  return (
    <ul className="hidden-list">
      {items.map((h) => (
        <li key={h.assetId}>
          <img src={thumbUrl(album, h.assetId)} alt="" loading="lazy" />
          <div>
            <strong>{h.fileName ?? '（照片已不在照片库里）'}</strong>
            <span className="muted path">{h.path}</span>
            <span className="muted">
              {h.reason && `${h.reason} · `}
              {formatDateTime(h.createdAt.replace(' ', 'T'), false)} 隐藏
            </span>
          </div>
          <button
            className="btn btn-small"
            onClick={async () => {
              await request('DELETE', `/api/admin/hidden/${h.assetId}`);
              await refresh();
            }}
          >
            <Eye size={14} /> 恢复
          </button>
        </li>
      ))}
    </ul>
  );
}
