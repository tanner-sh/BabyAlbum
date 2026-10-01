import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronLeft, ChevronRight, Download, Flag, Heart, Info, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { get, liveUrl, originalUrl, request, thumbUrl, useAlbum, useAssetInfo, videoUrl, type AlbumItem } from '../api';
import { formatBytes, formatDateTime } from '../format';
import { EditDateModal } from './DateFix';
import { LiveBadge } from './PhotoGrid';

type Props = {
  items: AlbumItem[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  /** 只有登录用户才有：把这张照片记为里程碑 */
  onMilestone?: (item: AlbumItem) => void;
};

export function Lightbox({ items, index, onIndexChange, onClose, onMilestone }: Props) {
  const album = useAlbum();
  const queryClient = useQueryClient();
  const item = items[index];
  const [showInfo, setShowInfo] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  // 收藏状态在本地立即更新，不等列表重新加载
  const [favorites, setFavorites] = useState<Record<string, boolean>>({});
  const info = useAssetInfo(showInfo ? item?.id : null);

  const go = (delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < items.length) onIndexChange(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingDate) return;
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  });

  // 预加载相邻的两张
  useEffect(() => {
    for (const i of [index - 1, index + 1]) {
      const it = items[i];
      if (it?.type === 'IMAGE') new Image().src = thumbUrl(album, it.id, 'preview');
    }
  }, [index, items, album]);

  if (!item) return null;
  const isFavorite = favorites[item.id] ?? item.isFavorite;

  async function toggleFavorite() {
    const next = !isFavorite;
    setFavorites((f) => ({ ...f, [item.id]: next }));
    try {
      await request('PUT', `/api/assets/${item.id}/favorite`, { isFavorite: next });
      queryClient.invalidateQueries({ queryKey: [album.base] });
    } catch {
      setFavorites((f) => ({ ...f, [item.id]: !next }));
    }
  }

  return (
    <div className="lightbox">
      <header className="lightbox-bar">
        <button className="icon-btn light" onClick={onClose} aria-label="关闭">
          <X size={22} />
        </button>
        <div className="lightbox-title">
          <strong>{item.age?.label ?? formatDateTime(item.takenAt, false)}</strong>
          <span>{item.age ? formatDateTime(item.takenAt) : item.fileName}</span>
        </div>
        <div className="lightbox-actions">
          {!album.readOnly && (
            <button className={`icon-btn light ${isFavorite ? 'is-fav' : ''}`} onClick={toggleFavorite} aria-label={isFavorite ? '取消收藏' : '收藏'}>
              <Heart size={20} fill={isFavorite ? 'currentColor' : 'none'} />
            </button>
          )}
          {onMilestone && (
            <button className="icon-btn light" onClick={() => onMilestone(item)} aria-label="记为里程碑" title="记为里程碑">
              <Flag size={20} />
            </button>
          )}
          {!album.readOnly && (
            <button className="icon-btn light" onClick={() => setEditingDate(true)} aria-label="修改日期" title="修改日期">
              <CalendarClock size={20} />
            </button>
          )}
          {album.allowDownload && (
            <a className="icon-btn light" href={originalUrl(album, item.id)} aria-label="下载原图" title="下载原图">
              <Download size={20} />
            </a>
          )}
          <button className={`icon-btn light ${showInfo ? 'active' : ''}`} onClick={() => setShowInfo((v) => !v)} aria-label="详细信息">
            <Info size={20} />
          </button>
        </div>
      </header>

      <Stage key={item.id} item={item} onPrev={() => go(-1)} onNext={() => go(1)} onClose={onClose} />
      {index > 0 && (
        <button className="lightbox-nav prev" onClick={() => go(-1)} aria-label="上一张">
          <ChevronLeft size={32} />
        </button>
      )}
      {index < items.length - 1 && (
        <button className="lightbox-nav next" onClick={() => go(1)} aria-label="下一张">
          <ChevronRight size={32} />
        </button>
      )}

      {showInfo && (
        <aside className="lightbox-info">
          {info.data ? (
            <dl>
              {info.data.babies.map((b) => (
                <div key={b.id}>
                  <dt>{b.name}</dt>
                  <dd>{b.ageLabel}</dd>
                </div>
              ))}
              <div>
                <dt>拍摄时间</dt>
                <dd>{formatDateTime(info.data.takenAt)}</dd>
              </div>
              {info.data.place && (
                <div>
                  <dt>地点</dt>
                  <dd>{info.data.place}</dd>
                </div>
              )}
              {info.data.camera && (
                <div>
                  <dt>设备</dt>
                  <dd>{info.data.camera}</dd>
                </div>
              )}
              <div>
                <dt>文件</dt>
                <dd>
                  {info.data.fileName}
                  {info.data.width && ` · ${info.data.width}×${info.data.height}`}
                  {info.data.fileSize ? ` · ${formatBytes(info.data.fileSize)}` : ''}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="muted">加载中…</p>
          )}
        </aside>
      )}

      {editingDate && <EditDateModal assetId={item.id} onClose={() => setEditingDate(false)} />}

      <div className="lightbox-counter">
        {index + 1} / {items.length}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 手势：缩放、拖动、滑动切换、下滑关闭、长按播放实况

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const LONG_PRESS_MS = 350;

type Point = { x: number; y: number };
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function Stage({ item, onPrev, onNext, onClose }: { item: AlbumItem; onPrev: () => void; onNext: () => void; onClose: () => void }) {
  const album = useAlbum();
  const stageRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const isVideo = item.type === 'VIDEO';
  // 导入过程中实况照片可能还没配对好，列表里没带视频 ID：手机拍的照片打开时再查一次
  const maybeLive = !isVideo && !item.livePhotoVideoId && /^IMG_/i.test(item.fileName);
  const liveCheck = useQuery({
    queryKey: [album.base, 'live-id', item.id],
    queryFn: () => get<{ videoId: string | null }>(`${album.base}/assets/${item.id}/live-id`),
    enabled: maybeLive,
    staleTime: 10 * 60_000,
  });
  const isLive = !isVideo && (!!item.livePhotoVideoId || !!liveCheck.data?.videoId);
  const [livePlaying, setLivePlaying] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  // 缩放和位移直接写到 style 上，不经过 React 渲染，手势才跟手
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const gesture = useRef<{
    pointers: Map<number, Point>;
    start?: { scale: number; x: number; y: number; dist: number; mid: Point; point: Point; time: number };
    moved: boolean;
    lastTap: number;
    pressTimer?: number;
  }>({ pointers: new Map(), moved: false, lastTap: 0 });

  function apply(animate = false) {
    const el = mediaRef.current;
    if (!el) return;
    const { scale, x, y } = view.current;
    el.style.transition = animate ? 'transform 0.2s ease-out' : 'none';
    el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    const isZoomed = scale > 1.01;
    if (isZoomed !== zoomed) setZoomed(isZoomed);
  }

  /** 以 p（相对舞台中心）为中心缩放到 scale，并限制拖动范围不超出图片边缘 */
  function zoomTo(scale: number, p: Point, base = view.current) {
    const s = Math.min(MAX_SCALE, Math.max(1, scale));
    const k = s / base.scale;
    view.current = { scale: s, x: p.x - (p.x - base.x) * k, y: p.y - (p.y - base.y) * k };
    clamp();
  }

  function clamp() {
    const el = mediaRef.current;
    const stage = stageRef.current;
    if (!el || !stage) return;
    const { scale } = view.current;
    if (scale <= 1) {
      view.current = { scale: 1, x: 0, y: 0 };
      return;
    }
    const maxX = Math.max(0, (el.offsetWidth * scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (el.offsetHeight * scale - stage.clientHeight) / 2);
    view.current.x = Math.min(maxX, Math.max(-maxX, view.current.x));
    view.current.y = Math.min(maxY, Math.max(-maxY, view.current.y));
  }

  /** 屏幕坐标 → 相对舞台中心 */
  function local(p: Point): Point {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: p.x - r.left - r.width / 2, y: p.y - r.top - r.height / 2 };
  }

  // 实况照片：打开时自动播放一次
  useEffect(() => {
    if (!isLive) return;
    const t = setTimeout(() => setLivePlaying(true), 400);
    return () => clearTimeout(t);
  }, [isLive]);

  // 触控板捏合（浏览器报告为带 ctrlKey 的滚轮事件）、Ctrl+滚轮缩放
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || isVideo) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && view.current.scale === 1) return;
      e.preventDefault();
      if (e.ctrlKey) zoomTo(view.current.scale * Math.exp(-e.deltaY / 100), local({ x: e.clientX, y: e.clientY }));
      else {
        view.current.x -= e.deltaX;
        view.current.y -= e.deltaY;
        clamp();
      }
      apply();
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  });

  function onPointerDown(e: React.PointerEvent) {
    // 视频自带的控制条要能正常点
    if (isVideo && e.pointerType === 'mouse') return;
    const g = gesture.current;
    stageRef.current?.setPointerCapture(e.pointerId);
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...g.pointers.values()];
    g.moved = false;
    g.start = {
      ...view.current,
      dist: pts.length > 1 ? dist(pts[0], pts[1]) : 0,
      mid: pts.length > 1 ? mid(pts[0], pts[1]) : pts[0],
      point: pts[0],
      time: Date.now(),
    };
    clearTimeout(g.pressTimer);
    // 手机上长按播放实况
    if (isLive && pts.length === 1 && e.pointerType !== 'mouse') g.pressTimer = window.setTimeout(() => !g.moved && setLivePlaying(true), LONG_PRESS_MS);
  }

  function onPointerMove(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g.pointers.has(e.pointerId) || !g.start) return;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...g.pointers.values()];
    if (dist(pts[0], g.start.point) > 8) g.moved = true;
    if (isVideo) return;

    if (pts.length >= 2 && g.start.dist > 0) {
      // 双指缩放：以两指中点为中心，同时跟随中点移动
      const m = mid(pts[0], pts[1]);
      const base = { scale: g.start.scale, x: g.start.x + (m.x - g.start.mid.x), y: g.start.y + (m.y - g.start.mid.y) };
      zoomTo(g.start.scale * (dist(pts[0], pts[1]) / g.start.dist), local(m), base);
      apply();
    } else if (pts.length === 1 && g.start.scale > 1) {
      // 放大后拖动查看
      view.current.x = g.start.x + (pts[0].x - g.start.point.x);
      view.current.y = g.start.y + (pts[0].y - g.start.point.y);
      clamp();
      apply();
    } else if (pts.length === 1 && g.moved) {
      // 没放大时跟随手指移动一点，提示可以滑动
      const dx = pts[0].x - g.start.point.x;
      const dy = pts[0].y - g.start.point.y;
      const el = mediaRef.current;
      if (el) {
        el.style.transition = 'none';
        el.style.transform = Math.abs(dy) > Math.abs(dx) && dy > 0 ? `translateY(${dy}px) scale(${1 - Math.min(dy / 2000, 0.2)})` : `translateX(${dx * 0.5}px)`;
      }
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g.pointers.has(e.pointerId) || !g.start) return;
    clearTimeout(g.pressTimer);
    const p = { x: e.clientX, y: e.clientY };
    const start = g.start;
    g.pointers.delete(e.pointerId);
    if (livePlaying && e.pointerType !== 'mouse') setLivePlaying(false);

    // 还有手指在屏幕上（双指变单指）：以剩下的手指重新开始
    if (g.pointers.size) {
      const rest = [...g.pointers.values()][0];
      g.start = { ...view.current, dist: 0, mid: rest, point: rest, time: Date.now() };
      return;
    }
    g.start = undefined;

    // 没移动：单击或双击（放大状态下也要能双击还原）
    if (!g.moved && start.dist === 0) {
      const now = Date.now();
      if (!isVideo && now - g.lastTap < 300) {
        if (view.current.scale > 1) view.current = { scale: 1, x: 0, y: 0 };
        else zoomTo(DOUBLE_TAP_SCALE, local(p));
        apply(true);
        g.lastTap = 0;
      } else g.lastTap = now;
      return;
    }
    // 缩放、放大后的拖动结束：缩得太小就还原
    if (start.scale > 1 || start.dist > 0) {
      if (view.current.scale < 1.05) view.current = { scale: 1, x: 0, y: 0 };
      apply(true);
      return;
    }
    const dx = p.x - start.point.x;
    const dy = p.y - start.point.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0) onPrev();
      else onNext();
    } else if (dy > 100 && dy > Math.abs(dx)) {
      onClose();
      return;
    }
    view.current = { scale: 1, x: 0, y: 0 };
    apply(true);
  }

  return (
    <div
      ref={stageRef}
      className={`lightbox-stage ${zoomed ? 'zoomed' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => isLive && e.preventDefault()}
    >
      <div ref={mediaRef} className="lightbox-media">
        {isVideo ? (
          <video src={videoUrl(album, item.id)} poster={thumbUrl(album, item.id, 'preview')} controls autoPlay playsInline />
        ) : (
          <>
            <img src={thumbUrl(album, item.id, 'preview')} alt={item.fileName} draggable={false} />
            {isLive && livePlaying && !zoomed && (
              <video className="live-video" src={liveUrl(album, item.id)} autoPlay muted playsInline onEnded={() => setLivePlaying(false)} onError={() => setLivePlaying(false)} />
            )}
          </>
        )}
      </div>
      {isLive && (
        <button
          className={`live-toggle ${livePlaying ? 'playing' : ''}`}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseEnter={() => setLivePlaying(true)}
          onClick={() => setLivePlaying((v) => !v)}
          title="播放实况（手机上长按照片）"
        >
          <LiveBadge />
          实况
        </button>
      )}
    </div>
  );
}
