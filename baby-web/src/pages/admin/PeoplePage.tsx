import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Baby as BabyIcon, Images, Merge, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { get, request, type AdminPerson, type PersonFace, type Sex, type SimilarPerson } from '../../api';
import { SexPicker } from '../../components/ClaimBaby';
import { FamilyIntro } from '../../components/FamilyIntro';
import { Lightbox } from '../../components/Lightbox';
import { Avatar, ErrorBox, Modal, Spinner, Toggle } from '../../components/ui';

/** 人物：人脸识别的结果。命名、设生日、合并（同一个人被拆成了几个）、设为宝宝 */
export function PeoplePage() {
  const [showHidden, setShowHidden] = useState(false);
  const people = useQuery({ queryKey: ['admin', 'people', showHidden], queryFn: () => get<AdminPerson[]>(`/api/admin/people?hidden=${showHidden}`) });
  const [open, setOpen] = useState<AdminPerson | null>(null);

  return (
    <div className="admin-page">
      <FamilyIntro />
      <div className="section-actions">
        <div>
          <h2>人物</h2>
          <p className="muted">按照片数量排序，点开可以命名、设为宝宝、合并同一个人。</p>
        </div>
        <label className="inline-check">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          显示已隐藏的
        </label>
      </div>
      {people.isPending ? (
        <Spinner label="正在统计每个人物的照片数…" />
      ) : people.isError ? (
        <ErrorBox error={people.error} />
      ) : !people.data.length ? (
        <div className="empty">
          <p className="empty-title">还没有识别出人物</p>
          <p>导入照片后，人脸识别需要一些时间。可以在“照片库”页面看进度。</p>
        </div>
      ) : (
        <div className="people-grid">
          {people.data.map((p) => (
            <button key={p.id} className={`person-card ${p.isHidden ? 'is-hidden' : ''}`} onClick={() => setOpen(p)}>
              <Avatar baby={{ name: p.name || '?', thumbnailUrl: p.thumbnailUrl }} size={88} />
              <strong>{p.name || '未命名'}</strong>
              <span className="muted">{p.assets.toLocaleString()} 张</span>
              {p.baby && (
                <span className="chip chip-accent">
                  <BabyIcon size={12} />
                  宝宝
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {open && people.data && <PersonModal person={open} others={people.data.filter((p) => p.id !== open.id)} onClose={() => setOpen(null)} />}
    </div>
  );
}

function PersonModal({ person, others, onClose }: { person: AdminPerson; others: AdminPerson[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(person.name);
  const [birthDate, setBirthDate] = useState(person.birthDate ?? '');
  const [isHidden, setIsHidden] = useState(person.isHidden);
  const [asBaby, setAsBaby] = useState(false);
  const [sex, setSex] = useState<Sex | null>(null);
  // 从没和这个人物同框过的人物，可能是同一个人
  const similar = useQuery({
    queryKey: ['admin', 'people', 'similar', person.id],
    queryFn: () => get<SimilarPerson[]>(`/api/admin/people/${person.id}/similar`),
    staleTime: 5 * 60_000,
  });
  const maybeSame = new Set((similar.data ?? []).map((p) => p.id));
  const [merging, setMerging] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [comparing, setComparing] = useState<AdminPerson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await request('PUT', `/api/admin/people/${person.id}`, { name, birthDate: birthDate || null, isHidden });
      if (merging.length) await request('POST', `/api/admin/people/${person.id}/merge`, { ids: merging });
      if (asBaby) await request('POST', '/api/babies', { name, immichPersonId: person.id, birthday: birthDate, sex });
      await queryClient.invalidateQueries();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      setBusy(false);
    }
  }

  const sorted = [...others].sort((a, b) => Number(maybeSame.has(b.id)) - Number(maybeSame.has(a.id)));
  const candidates = showAll ? sorted : sorted.slice(0, 40);

  const toggle = (id: string, on: boolean) => setMerging((m) => (on ? [...new Set([...m, id])] : m.filter((x) => x !== id)));

  return (
    <>
      <Modal
        title={person.name || '未命名的人物'}
        onClose={onClose}
        wide
        footer={
          <>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button className="btn btn-primary" disabled={busy || (asBaby && (!name.trim() || !birthDate))} onClick={save}>
              {merging.length ? `保存并合并 ${merging.length} 个人物` : '保存'}
            </button>
          </>
        }
      >
        <div className="person-editor">
          <Avatar baby={{ name: person.name || '?', thumbnailUrl: person.thumbnailUrl }} size={120} />
          <div className="form">
            <p className="muted">出现在 {person.assets.toLocaleString()} 张照片里</p>
            <label className="field">
              <span>名字</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} placeholder="比如：宝宝的小名、妈妈" />
            </label>
            <label className="field">
              <span>生日</span>
              <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
            </label>
            <Toggle checked={isHidden} onChange={setIsHidden} label="隐藏" hint="路人、不认识的人可以隐藏，列表里就不显示了" />
            {person.baby ? (
              <p className="chip chip-accent">已经是宝宝：{person.baby.name}</p>
            ) : (
              <Toggle checked={asBaby} onChange={setAsBaby} label="设为宝宝" hint="在宝宝相册里按年龄整理这个人的照片（需要填名字和生日）" />
            )}
            {asBaby && (
              <div className="field">
                <span>性别（用于和 WHO 生长标准对比，可以不填）</span>
                <SexPicker value={sex} onChange={setSex} />
              </div>
            )}
          </div>
        </div>

        <FaceStrip person={person} title="TA 的照片" size={8} hideAvatar />

      <div className="merge-section">
          <h3>
            <Merge size={16} /> 合并到这个人物
          </h3>
          <p className="muted">
            勾选其实是同一个人的人物（比如宝宝更小时候的照片），保存后它们的照片都会归到“{name || '这个人物'}”。标着“可能是同一人”的从没和 TA 同框过，排在前面。拿不准的点卡片右上角的照片按钮，把两边的脸放在一起对比。
          </p>
          <div className="merge-grid">
            {candidates.map((p) => {
              const on = merging.includes(p.id);
              return (
                <div key={p.id} className={`merge-option ${on ? 'selected' : ''}`}>
                  <button type="button" className="merge-option-pick" onClick={() => toggle(p.id, !on)}>
                    <Avatar baby={{ name: p.name || '?', thumbnailUrl: p.thumbnailUrl }} size={64} />
                    <span>{p.name || '未命名'}</span>
                    <span className="muted">{p.assets} 张</span>
                    {maybeSame.has(p.id) && <span className="chip chip-accent small">可能是同一人</span>}
                  </button>
                  <button type="button" className="merge-option-look" onClick={() => setComparing(p)} title="看照片，和这个人物对比" aria-label="看照片">
                    <Images size={15} />
                  </button>
                </div>
              );
            })}
          </div>
          {!showAll && others.length > candidates.length && (
            <button className="btn" onClick={() => setShowAll(true)}>
              显示全部 {others.length} 个人物
            </button>
          )}
        </div>
        {error && <div className="error-box">{error}</div>}
      </Modal>
      {comparing && (
        <CompareModal
          person={person}
          name={name}
          other={comparing}
          selected={merging.includes(comparing.id)}
          onPick={(on) => {
            toggle(comparing.id, on);
            setComparing(null);
          }}
          onClose={() => setComparing(null)}
        />
      )}
    </>
  );
}

/** 合并前对比：两边各随机取几张照片，只看脸，判断是不是同一个人 */
function CompareModal({
  person,
  name,
  other,
  selected,
  onPick,
  onClose,
}: {
  person: AdminPerson;
  name: string;
  other: AdminPerson;
  selected: boolean;
  onPick: (on: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="是同一个人吗？"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="spacer" />
          {selected ? (
            <button className="btn" onClick={() => onPick(false)}>
              不是，取消勾选
            </button>
          ) : (
            <button className="btn" onClick={onClose}>
              不是
            </button>
          )}
          <button className="btn btn-primary" onClick={() => onPick(true)}>
            是同一个人，勾选合并
          </button>
        </>
      }
    >
      <FaceStrip person={person} title={name || person.name || '这个人物'} size={8} />
      <FaceStrip person={other} title={other.name || '未命名'} size={16} />
    </Modal>
  );
}

function FaceStrip({ person, title, size, hideAvatar }: { person: AdminPerson; title: string; size: number; hideAvatar?: boolean }) {
  const faces = useQuery({
    queryKey: ['admin', 'people', 'faces', person.id, size],
    queryFn: () => get<PersonFace[]>(`/api/admin/people/${person.id}/faces?size=${size}`),
    staleTime: Infinity,
  });
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section className="face-strip">
      <div className="face-strip-head">
        {!hideAvatar && <Avatar baby={{ name: title, thumbnailUrl: person.thumbnailUrl }} size={32} />}
        <strong>{title}</strong>
        <span className="muted">{person.assets.toLocaleString()} 张</span>
        <span className="spacer" />
        <button className="btn btn-small" disabled={faces.isFetching} onClick={() => faces.refetch()}>
          <RefreshCw size={14} /> 换一批
        </button>
      </div>
      {faces.isPending ? (
        <Spinner label="正在找照片…" />
      ) : faces.isError ? (
        <ErrorBox error={faces.error} />
      ) : !faces.data.length ? (
        <p className="muted">没有找到照片</p>
      ) : (
        <div className="face-grid">
          {faces.data.map((f, i) => (
            <FaceCrop key={f.id} face={f} onClick={() => setOpen(i)} />
          ))}
        </div>
      )}
      {open !== null && faces.data && (
        // 盖在人物弹窗上面
        <div className="lightbox-layer">
          <Lightbox items={faces.data} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />
        </div>
      )}
    </section>
  );
}

/** 从照片里裁出这个人的脸（留一些边，能看到发型和脸型）；找不到脸的位置就显示整张照片 */
function FaceCrop({ face, onClick }: { face: PersonFace; onClick: () => void }) {
  const url = `/api/assets/${face.id}/thumbnail?size=preview`;
  const title = `${new Date(face.takenAt).toLocaleDateString('zh-CN')}，点开看整张照片`;
  if (!face.box) return <button type="button" className="face-crop" onClick={onClick} title={title} style={{ backgroundImage: `url(${url})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />;
  const { x, y, w, h, ratio } = face.box;
  // 以照片高度为 1，宽度为 ratio；取一个包住脸、放大 1.8 倍的正方形，不超出照片
  const side = Math.min(Math.max(w * ratio, h) * 1.8, ratio, 1);
  const sw = side / ratio;
  const sh = side;
  const left = Math.min(Math.max(x + w / 2 - sw / 2, 0), 1 - sw);
  const top = Math.min(Math.max(y + h / 2 - sh / 2, 0), 1 - sh);
  const pos = (start: number, span: number) => (span >= 1 ? 0 : (start / (1 - span)) * 100);
  return (
    <button
      type="button"
      className="face-crop"
      onClick={onClick}
      title={title}
      style={{
        backgroundImage: `url(${url})`,
        backgroundSize: `${100 / sw}% ${100 / sh}%`,
        backgroundPosition: `${pos(left, sw)}% ${pos(top, sh)}%`,
      }}
    />
  );
}
