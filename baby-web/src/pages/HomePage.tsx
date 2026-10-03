import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Baby as BabyIcon, BellRing, CalendarHeart, ChevronRight, Flag, Images, NotebookPen, Plus, Ruler } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useNavigate, useOutletContext } from 'react-router';
import { canEdit, get, request, thumbUrl, useAlbum, useBabies, useBabyHome, useJournal, useMeasurements, useMilestones, useOnThisDay, type AdminPerson, type Baby, type Me, type Sex } from '../api';
import { ClaimBanner, SexPicker } from '../components/ClaimBaby';
import { FaceStrip } from '../components/PersonPhotos';
import { RecentInteractions } from '../components/RecentInteractions';
import { TodoCard } from '../components/TodoCard';
import { ReviewBanner } from '../components/ReviewTab';
import { Avatar, Empty, ErrorBox, Modal, Spinner } from '../components/ui';
import { Lightbox } from '../components/Lightbox';
import { PhotoGrid } from '../components/PhotoGrid';
import { daysBetween, formatDate, nextMoment, today } from '../format';

export function HomePage() {
  const me = useOutletContext<Me>();
  const isAdmin = me.role === 'admin';
  const babies = useBabies();
  const [adding, setAdding] = useState(false);

  if (babies.isPending) return <Spinner />;
  if (babies.isError) return <ErrorBox error={babies.error} />;

  return (
    <>
      {babies.data.length === 0 ? (
        <>
          {isAdmin && <TodoCard />}
          {/* 还没有宝宝时，主动问照片最多的人物是不是宝宝 */}
          {isAdmin && <ClaimBanner />}
          <Empty icon={<BabyIcon size={48} />} title="欢迎使用宝宝相册">
            {isAdmin ? (
              <>
                <p>先在“我的 → 管理 → 照片库”里添加存储、导入照片，等人脸识别完成后，在这里选出宝宝的脸，之后所有有宝宝的照片都会按年龄自动整理好。</p>
                <button className="btn btn-primary" onClick={() => setAdding(true)}>
                  <Plus size={16} />
                  添加宝宝
                </button>
              </>
            ) : (
              <p>管理员还没有添加宝宝，或者还没有给你开放查看权限。</p>
            )}
          </Empty>
        </>
      ) : (
        // 电脑上两栏：左边是宝宝（封面、最近的照片），右边是回顾、留言、待办；手机上从上往下排
        <div className="home">
          <div className="home-main">
            {babies.data.map((b) => (
              <section key={b.id} className="home-baby">
                <BabyHero baby={b} />
                <RecentPhotos baby={b} />
              </section>
            ))}
            {isAdmin && (
              <button className="link-btn add-baby" onClick={() => setAdding(true)}>
                <Plus size={14} /> 添加宝宝
              </button>
            )}
          </div>
          <aside className="home-side">
            {babies.data.map((b) => (
              <ReviewBanner key={`review-${b.id}`} baby={b} />
            ))}
            {babies.data.map((b) => (
              <OnThisDayCard key={`otd-${b.id}`} baby={b} />
            ))}
            {babies.data.map((b) => (
              <RecordsCard key={`records-${b.id}`} baby={b} editable={canEdit(me)} />
            ))}
            <RecentInteractions />
            {/* 待办只有管理员看得到，放在旁边，默认收成一行（有严重问题才展开） */}
            {isAdmin && <TodoCard />}
          </aside>
        </div>
      )}
      {adding && <AddBabyModal onClose={() => setAdding(false)} />}
    </>
  );
}

/** 宝宝的封面：最近一张收藏的照片做背景，名字、月龄、第几天、下一个值得期待的日子 */
function BabyHero({ baby }: { baby: Baby }) {
  const album = useAlbum();
  const home = useBabyHome(baby.id);
  const cover = home.data?.cover;
  const now = today();
  const days = daysBetween(baby.birthday, now) + 1;
  const next = nextMoment(baby.birthday, now);
  return (
    <Link to={`/baby/${baby.id}`} className={`baby-hero ${cover ? 'has-cover' : ''}`} style={cover ? { backgroundImage: `url(${thumbUrl(album, cover.id, 'preview')})` } : undefined}>
      <div className="baby-hero-text">
        <Avatar baby={baby} size={56} />
        <div>
          <h2>
            {baby.name}
            <span className="baby-hero-age">{baby.ageLabel}</span>
          </h2>
          <p>
            <span>{days > 0 ? `今天是第 ${days.toLocaleString()} 天` : `${formatDate(baby.birthday)} 出生`}</span>
            {next && <span className="baby-hero-next">{next}</span>}
          </p>
        </div>
        <ChevronRight size={22} className="baby-hero-go" />
      </div>
    </Link>
  );
}

/** 最近的照片：点一张直接看大图 */
function RecentPhotos({ baby }: { baby: Baby }) {
  const home = useBabyHome(baby.id);
  const [open, setOpen] = useState<number | null>(null);
  const items = home.data?.recent ?? [];
  if (home.isPending) return <Spinner />;
  if (!items.length) return null;
  return (
    <div className="home-recent">
      <header className="group-header">
        <h3>
          <Images size={18} /> 最近的照片
        </h3>
        {home.data!.thisWeek > 0 && <span className="muted">这周新增 {home.data!.thisWeek.toLocaleString()} 张</span>}
        <Link to={`/baby/${baby.id}`} className="muted small home-more">
          全部 ›
        </Link>
      </header>
      <PhotoGrid items={items} onOpen={setOpen} />
      {open !== null && <Lightbox items={items} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} hasMore />}
    </div>
  );
}

/** 那年今日：往年的今天，每一年一行（当时多大、几张），点照片直接看大图 */
function OnThisDayCard({ baby }: { baby: Baby }) {
  const album = useAlbum();
  const memories = useOnThisDay(baby.id);
  const [open, setOpen] = useState<{ year: number; index: number } | null>(null);
  const years = (memories.data ?? []).slice(0, 3);
  if (!years.length) return null;
  const opened = open && years.find((y) => y.year === open.year);
  return (
    <section className="home-card">
      <header className="home-card-head">
        <CalendarHeart size={18} />
        <strong>{baby.name} · 那年今日</strong>
        <Link to={`/baby/${baby.id}?tab=review&view=memories`} className="muted small home-more">
          全部 ›
        </Link>
      </header>
      {years.map((y) => (
        <div key={y.year} className="otd-year">
          <p>
            <strong>{y.yearsAgo} 年前</strong>
            <span className="muted">
              {' '}
              · {y.ageLabel} · {y.items.length} 张
            </span>
          </p>
          <div className="otd-thumbs">
            {y.items.slice(0, 4).map((item, i) => (
              <button key={item.id} type="button" onClick={() => setOpen({ year: y.year, index: i })} aria-label={`看 ${y.yearsAgo} 年前的照片`}>
                <img src={thumbUrl(album, item.id)} alt="" loading="lazy" />
                {i === 3 && y.items.length > 4 && <span className="otd-more">+{y.items.length - 4}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
      {opened && <Lightbox items={opened.items} index={open.index} onIndexChange={(index) => setOpen({ year: opened.year, index })} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** 最近的记录（里程碑、日记、身高体重），能编辑的家人还会看到提醒 */
function RecordsCard({ baby, editable }: { baby: Baby; editable: boolean }) {
  const milestones = useMilestones(baby.id);
  const journal = useJournal(baby.id);
  const measurements = useMeasurements(baby.id);
  if (milestones.isPending || journal.isPending || measurements.isPending) return null;
  const milestone = milestones.data?.[0];
  const entry = journal.data?.[0];
  const measure = measurements.data?.at(-1);
  const now = today();
  const sinceMeasure = measure ? daysBetween(measure.date, now) : null;
  const view = (v: string) => `/baby/${baby.id}?tab=records&view=${v}`;

  const reminders: { to: string; text: string }[] = [];
  if (editable) {
    if (sinceMeasure === null) reminders.push({ to: view('measurements'), text: '还没记过身高体重，记一笔吧' });
    else if (sinceMeasure > 30) reminders.push({ to: view('measurements'), text: `已经 ${sinceMeasure} 天没记身高体重了` });
    if (!milestone) reminders.push({ to: view('milestones'), text: '记下第一个里程碑' });
  }
  if (!milestone && !entry && !measure && !reminders.length) return null;

  const size = measure && [measure.heightCm && `身高 ${measure.heightCm} cm`, measure.weightKg && `体重 ${measure.weightKg} kg`, measure.headCm && `头围 ${measure.headCm} cm`].filter(Boolean).join(' · ');
  return (
    <section className="home-card">
      <header className="home-card-head">
        <NotebookPen size={18} />
        <strong>{baby.name}的记录</strong>
        <Link to={view('milestones')} className="muted small home-more">
          全部 ›
        </Link>
      </header>
      <ul className="home-records">
        {milestone && (
          <li>
            <Link to={view('milestones')}>
              <Flag size={16} />
              <span>
                <strong>{milestone.title}</strong>
                <span className="muted small">
                  {formatDate(milestone.date)} · {milestone.ageLabel}
                </span>
              </span>
            </Link>
          </li>
        )}
        {entry && (
          <li>
            <Link to={view('journal')}>
              <NotebookPen size={16} />
              <span>
                <span className="home-records-text">{entry.text}</span>
                <span className="muted small">
                  {formatDate(entry.date)} · {entry.ageLabel}
                  {entry.authorName && ` · ${entry.authorName}`}
                </span>
              </span>
            </Link>
          </li>
        )}
        {measure && size && (
          <li>
            <Link to={view('measurements')}>
              <Ruler size={16} />
              <span>
                <strong>{size}</strong>
                <span className="muted small">
                  {formatDate(measure.date)} · {measure.ageLabel}
                </span>
              </span>
            </Link>
          </li>
        )}
        {reminders.map((r) => (
          <li key={r.text} className="home-reminder">
            <Link to={r.to}>
              <BellRing size={16} />
              <span>{r.text}</span>
              <ChevronRight size={16} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AddBabyModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const people = useQuery({ queryKey: ['admin', 'people', false], queryFn: () => get<AdminPerson[]>('/api/admin/people?hidden=false') });
  const [person, setPerson] = useState<AdminPerson | null>(null);
  const [name, setName] = useState('');
  const [birthday, setBirthday] = useState('');
  const [sex, setSex] = useState<Sex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function choose(p: AdminPerson) {
    setPerson(p);
    setName(p.name);
    setBirthday(p.birthDate ?? '');
  }

  async function save() {
    setError(null);
    setSaving(true);
    try {
      // 同时给人物命名、设生日（人物列表里也能看到）
      await request('PUT', `/api/admin/people/${person!.id}`, { name, birthDate: birthday });
      const baby = await request<Baby>('POST', '/api/babies', { name, immichPersonId: person!.id, birthday, sex });
      await queryClient.invalidateQueries();
      navigate(`/baby/${baby.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      setSaving(false);
    }
  }

  // 照片最多的前 24 个人物，宝宝一般在最前面
  const available = (people.data ?? []).filter((p) => !p.baby).slice(0, 24);

  return (
    <Modal
      title="添加宝宝"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!person || !name.trim() || !birthday || saving} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <div className="form">
        <div className="field">
          <span>1. 选出宝宝的脸（按照片数量排序）</span>
          {people.isPending ? (
            <Spinner label="正在加载人物…" />
          ) : people.isError ? (
            <ErrorBox error={people.error} />
          ) : available.length === 0 ? (
            <p className="muted">还没有识别出人物。请先在“管理 → 照片库”导入照片，人脸识别完成后再来添加。</p>
          ) : (
            <div className="people-picker">
              {available.map((p) => (
                <button key={p.id} type="button" className={`person ${person?.id === p.id ? 'selected' : ''}`} onClick={() => choose(p)}>
                  <Avatar baby={{ name: p.name || '?', thumbnailUrl: p.thumbnailUrl }} size={64} />
                  <span>{p.name || '未命名'}</span>
                  <span className="muted">{p.assets} 张</span>
                </button>
              ))}
            </div>
          )}
          <p className="muted">同一个宝宝被识别成了好几个人物？可以先在“管理 → 人物”里合并。</p>
        </div>
        {person && (
          <>
            {/* 头像可能看不清，确认一下选对了人 */}
            <FaceStrip key={person.id} person={person} title="确认一下：TA 的照片" size={8} hideAvatar />
            <label className="field">
              <span>2. 名字</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} />
            </label>
            <label className="field">
              <span>3. 生日</span>
              <input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />
            </label>
            <div className="field">
              <span>4. 性别（用于和 WHO 生长标准对比，可以不填）</span>
              <SexPicker value={sex} onChange={setSex} />
            </div>
          </>
        )}
        {error && <div className="error-box">{error}</div>}
      </div>
    </Modal>
  );
}
