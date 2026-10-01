import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Baby as BabyIcon, CalendarHeart, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useNavigate, useOutletContext } from 'react-router';
import { get, request, thumbUrl, useAlbum, useBabies, useOnThisDay, type AdminPerson, type Baby, type Me, type Sex } from '../api';
import { ClaimBanner, SexPicker } from '../components/ClaimBaby';
import { RecentInteractions } from '../components/RecentInteractions';
import { TodoCard } from '../components/TodoCard';
import { ReviewBanner } from '../components/ReviewTab';
import { Avatar, Empty, ErrorBox, Modal, Spinner } from '../components/ui';
import { formatDate } from '../format';

export function HomePage() {
  const me = useOutletContext<Me>();
  const isAdmin = me.role === 'admin';
  const babies = useBabies();
  const [adding, setAdding] = useState(false);

  if (babies.isPending) return <Spinner />;
  if (babies.isError) return <ErrorBox error={babies.error} />;

  return (
    <>
      {isAdmin && <TodoCard />}
      {babies.data.length === 0 ? (
        <>
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
        <>
          <div className="baby-cards">
            {babies.data.map((b) => (
              <Link key={b.id} to={`/baby/${b.id}`} className="baby-card">
                <Avatar baby={b} size={56} />
                <div>
                  <h2>{b.name}</h2>
                  <p className="baby-age">{b.ageLabel}</p>
                  <p className="muted small">{formatDate(b.birthday)} 出生</p>
                </div>
              </Link>
            ))}
          </div>
          {isAdmin && (
            <button className="link-btn add-baby" onClick={() => setAdding(true)}>
              <Plus size={14} /> 添加宝宝
            </button>
          )}
          {babies.data.map((b) => (
            <ReviewBanner key={`review-${b.id}`} baby={b} />
          ))}
          {babies.data.map((b) => (
            <TodayMemories key={b.id} baby={b} />
          ))}
          <RecentInteractions />
        </>
      )}
      {adding && <AddBabyModal onClose={() => setAdding(false)} />}
    </>
  );
}

function TodayMemories({ baby }: { baby: Baby }) {
  const album = useAlbum();
  const memories = useOnThisDay(baby.id);
  const first = memories.data?.[0];
  if (!first) return null;
  const count = memories.data!.reduce((n, e) => n + e.items.length, 0);
  return (
    <Link to={`/baby/${baby.id}?tab=review&view=memories`} className="memory-banner">
      <div className="memory-text">
        <CalendarHeart size={20} />
        <div>
          <strong>
            {baby.name} · {first.yearsAgo} 年前的今天
          </strong>
          <span className="muted">
            {first.ageLabel}，往年今天共 {count} 张
          </span>
        </div>
      </div>
      <div className="memory-thumbs">
        {first.items.slice(0, 4).map((i) => (
          <img key={i.id} src={thumbUrl(album, i.id)} alt="" loading="lazy" />
        ))}
      </div>
    </Link>
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

  function choose(p: AdminPerson) {
    setPerson(p);
    setName(p.name);
    setBirthday(p.birthDate ?? '');
  }

  async function save() {
    setError(null);
    try {
      // 同时给人物命名、设生日（人物列表里也能看到）
      await request('PUT', `/api/admin/people/${person!.id}`, { name, birthDate: birthday });
      const baby = await request<Baby>('POST', '/api/babies', { name, immichPersonId: person!.id, birthday, sex });
      await queryClient.invalidateQueries();
      navigate(`/baby/${baby.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
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
          <button className="btn btn-primary" disabled={!person || !name.trim() || !birthday} onClick={save}>
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
