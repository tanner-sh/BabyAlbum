import { Gift, Play, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { thumbUrl, useAlbum, useReview, type AlbumItem, type Baby, type ReviewKind } from '../api';
import { ageMonths, daysBetween, formatDate, monthDate, monthsLabel, today } from '../format';
import { Lightbox } from './Lightbox';
import { Slideshow } from './Slideshow';
import { Empty, ErrorBox, Spinner } from './ui';

const yearLabel = (i: number) => (i === 0 ? '出生第一年' : `${i} 岁这一年`);
const monthLabel = (i: number) => (i === 0 ? '第一个月' : monthsLabel(i));

/** 最近一个值得回顾的时间点：刚过完的那个月 */
function defaultSelection(baby: Baby): { kind: ReviewKind; index: number } {
  const months = Math.max(0, ageMonths(baby.birthday, today()));
  return { kind: 'month', index: Math.max(0, months - 1) };
}

/** 自动回顾：每个月、每一年自动挑一组精选照片，可以连起来播放 */
export function ReviewTab({ baby, onMilestone }: { baby: Baby; onMilestone?: (item: AlbumItem) => void }) {
  const album = useAlbum();
  const [params, setParams] = useSearchParams();
  const fallback = defaultSelection(baby);
  const kind = (params.get('kind') === 'year' ? 'year' : params.get('kind') === 'month' ? 'month' : fallback.kind) as ReviewKind;
  const index = params.has('index') ? Math.max(0, Number(params.get('index')) || 0) : kind === fallback.kind ? fallback.index : 0;
  const review = useReview(baby.id, kind, index);
  const [open, setOpen] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  const months = Math.max(0, ageMonths(baby.birthday, today()));
  const years = Math.floor(months / 12);

  const select = (k: ReviewKind, i: number) =>
    setParams(
      (p) => {
        p.set('kind', k);
        p.set('index', String(i));
        return p;
      },
      { replace: true },
    );

  return (
    <>
      {/* 选哪一段：年和月放在一个下拉框里；播放按钮在同一行，照片尽量往上放 */}
      <div className="review-bar">
        <select
          aria-label="回顾哪一段"
          value={`${kind}:${index}`}
          onChange={(e) => {
            const [k, i] = e.target.value.split(':');
            select(k as ReviewKind, Number(i));
          }}
        >
          <optgroup label="按年">
            {Array.from({ length: years + 1 }, (_, i) => years - i).map((i) => (
              <option key={`y${i}`} value={`year:${i}`}>
                {yearLabel(i)}
                {i === years ? '（进行中）' : ''}
              </option>
            ))}
          </optgroup>
          <optgroup label="按月">
            {Array.from({ length: months + 1 }, (_, i) => months - i).map((i) => (
              <option key={`m${i}`} value={`month:${i}`}>
                {monthLabel(i)}（{formatDate(monthDate(baby.birthday, i))} 起）{i === months ? '· 进行中' : ''}
              </option>
            ))}
          </optgroup>
        </select>
        {review.data && review.data.items.length > 0 && (
          <button className="btn btn-primary" onClick={() => setPlaying(true)}>
            <Play size={16} fill="currentColor" />
            播放
          </button>
        )}
      </div>

      {review.isPending ? (
        <Spinner label="正在挑选精选照片…" />
      ) : review.isError ? (
        <ErrorBox error={review.error} />
      ) : !review.data.items.length ? (
        <Empty icon={<Sparkles size={40} />} title={`${kind === 'year' ? yearLabel(index) : monthLabel(index)}还没有照片`} />
      ) : (
        <>
          <p
            className="muted small review-summary"
            title={`优先收藏的、${baby.name}的脸大的、分辨率高的，连拍只留一张，尽量每${kind === 'year' ? '个月' : '天'}都有`}
          >
            {formatDate(review.data.from)} – {formatDate(review.data.to)} · 从 {review.data.total.toLocaleString()} 张里挑了 {review.data.items.length} 张
          </p>
          <div className="review-grid">
            {review.data.items.map((item, i) => (
              <button key={item.id} className="review-cell" onClick={() => setOpen(i)}>
                <img src={thumbUrl(album, item.id, i % 7 === 0 ? 'preview' : 'thumbnail')} alt="" loading="lazy" />
                <span className="review-caption">{item.age?.label}</span>
              </button>
            ))}
          </div>
          {open !== null && <Lightbox items={review.data.items} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} onMilestone={onMilestone} />}
          {playing && (
            <Slideshow
              title={`${baby.name} · ${kind === 'year' ? yearLabel(index) : monthLabel(index)}`}
              slides={review.data.items.map((i) => ({ id: i.id, caption: i.age?.label ?? '' }))}
              onClose={() => setPlaying(false)}
            />
          )}
        </>
      )}
    </>
  );
}

/** 首页提示：生日、满月后的一周内，提醒看回顾 */
export function ReviewBanner({ baby }: { baby: Baby }) {
  const now = today();
  const months = ageMonths(baby.birthday, now);
  if (months <= 0) return null;
  const since = daysBetween(monthDate(baby.birthday, months), now);
  if (since > 7) return null;
  const isBirthday = months % 12 === 0;
  // 3 岁以后只在生日提醒
  if (!isBirthday && months >= 36) return null;
  const to = isBirthday
    ? `/baby/${baby.id}?tab=review&kind=year&index=${months / 12 - 1}`
    : `/baby/${baby.id}?tab=review&kind=month&index=${months - 1}`;
  return (
    <Link to={to} className="memory-banner review-banner">
      <div className="memory-text">
        <Gift size={20} />
        <div>
          <strong>
            {isBirthday ? `${baby.name} ${months / 12} 岁啦` : `${baby.name}满 ${monthsLabel(months)}啦`}
            {since === 0 ? '（就是今天）' : ''}
          </strong>
          <span className="muted">{isBirthday ? '看看这一年的精选照片' : '看看这个月的精选照片'}</span>
        </div>
      </div>
      <span className="btn btn-primary">看回顾</span>
    </Link>
  );
}
