import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Baby as BabyIcon, Check, EyeOff, SkipForward, Undo2, Users } from 'lucide-react';
import { useState } from 'react';
import { get, request, type UnnamedPerson } from '../api';
import { ClaimModal } from './ClaimBaby';
import { PersonPhotosButton } from './PersonPhotos';
import { attempt, Avatar, ErrorBox, Spinner } from './ui';

// 认识家里人：给常和宝宝一起出现的人命名。称呼由用户自己选或输入，不做任何假设
const RELATIONS = ['爸爸', '妈妈', '爷爷', '奶奶', '外公', '外婆', '哥哥', '姐姐', '弟弟', '妹妹', '叔叔', '阿姨'];

function useUnnamed() {
  return useQuery({ queryKey: ['admin', 'people', 'unnamed'], queryFn: () => get<UnnamedPerson[]>('/api/admin/people/unnamed'), staleTime: 5 * 60_000 });
}

/** 人物页顶部：这几位是谁？ */
export function FamilyIntro() {
  const unnamed = useUnnamed();
  if (unnamed.isPending) return <Spinner label="正在找经常和宝宝在一起的人…" />;
  if (unnamed.isError) return <ErrorBox error={unnamed.error} />;
  if (!unnamed.data.length) return null;
  return (
    <section className="family-intro">
      <h2>
        <Users size={18} /> 这几位是谁？
      </h2>
      <p className="muted">常和宝宝同框的排在前面。头像看不清的点“看照片”。起好名字，就能看宝宝和 TA 的合照、全家福。</p>
      <div className="family-cards">
        {unnamed.data.map((p) => (
          <FamilyCard key={p.id} person={p} />
        ))}
      </div>
    </section>
  );
}

function FamilyCard({ person }: { person: UnnamedPerson }) {
  const queryClient = useQueryClient();
  const [custom, setCustom] = useState('');
  const [done, setDone] = useState<{ label: string; undo: () => Promise<unknown> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [claiming, setClaiming] = useState(false);

  // 人物列表、家人筛选都要更新；这张卡片先留着显示结果
  const refresh = () => {
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('people') && !q.queryKey.includes('unnamed') });
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('companions') });
  };

  async function act(fn: () => Promise<unknown>, label: string, undo: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      setDone({ label, undo });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
    setBusy(false);
  }

  /** 点错了可以撤销，卡片回到没选的样子 */
  async function undo() {
    if (!done) return;
    setBusy(true);
    if (await attempt(done.undo)) {
      setDone(null);
      setCustom('');
      refresh();
    }
    setBusy(false);
  }

  const update = (body: object) => () => request('PUT', `/api/admin/people/${person.id}`, body);
  const name = (n: string) => act(update({ name: n }), `已命名为“${n}”`, update({ name: '' }));

  return (
    <article className={`family-card ${done ? 'done' : ''}`}>
      <Avatar baby={{ name: '?', thumbnailUrl: person.thumbnailUrl }} size={96} />
      <span className="muted small">
        {person.assets.toLocaleString()} 张{person.withBaby > 0 && `，和宝宝同框 ${person.withBaby.toLocaleString()} 张`}
      </span>
      {done ? (
        <>
          <p className="family-done">
            <Check size={16} /> {done.label}
          </p>
          <button className="link-btn small" disabled={busy} onClick={undo}>
            <Undo2 size={14} /> 撤销
          </button>
        </>
      ) : (
        <>
          <PersonPhotosButton person={person} />
          <div className="chips center">
            {RELATIONS.map((r) => (
              <button key={r} className="chip" disabled={busy} onClick={() => name(r)}>
                {r}
              </button>
            ))}
          </div>
          <form
            className="family-custom"
            onSubmit={(e) => {
              e.preventDefault();
              if (custom.trim()) void name(custom.trim());
            }}
          >
            <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="其他称呼或名字" maxLength={50} />
            <button className="btn btn-small" disabled={busy || !custom.trim()}>
              好
            </button>
          </form>
          <div className="family-actions">
            <button className="btn btn-small" disabled={busy} onClick={() => act(update({ isHidden: true }), '已隐藏（路人）', update({ isHidden: false }))}>
              <EyeOff size={14} /> 路人，隐藏
            </button>
            <button
              className="btn btn-small"
              disabled={busy}
              onClick={() =>
                act(
                  () => request('POST', `/api/admin/people/${person.id}/skip`),
                  '先跳过',
                  () => request('DELETE', `/api/admin/people/${person.id}/skip`),
                )
              }
            >
              <SkipForward size={14} /> 跳过
            </button>
          </div>
          {/* 家里的另一个孩子 */}
          <button className="link-btn small" onClick={() => setClaiming(true)}>
            <BabyIcon size={14} /> 这是另一个宝宝
          </button>
        </>
      )}
      {error && <div className="error-box">{error}</div>}
      {claiming && <ClaimModal personId={person.id} assets={person.assets} thumbnailUrl={person.thumbnailUrl} onClose={() => setClaiming(false)} />}
    </article>
  );
}
