import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Images, Merge, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { get, request, type Baby, type PersonSuggestion, type Sex, type SimilarPerson } from '../api';
import { CompareModal, FaceStrip, PersonPhotosButton } from './PersonPhotos';
import { attempt, Avatar, ErrorBox, Modal, Spinner } from './ui';

// 宝宝认领引导：人脸识别出人物后，主动问“这是宝宝吗？”，并找出可能是同一个人的其他人物一起合并

export function SexPicker({ value, onChange }: { value: Sex | null; onChange: (v: Sex | null) => void }) {
  return (
    <div className="chips">
      {(
        [
          ['boy', '男孩'],
          ['girl', '女孩'],
        ] as const
      ).map(([v, label]) => (
        <button key={v} type="button" className={`chip ${value === v ? 'chip-accent' : ''}`} onClick={() => onChange(value === v ? null : v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** 首页提示：发现一个出现在很多照片里、还没命名的人物 */
export function ClaimBanner() {
  const queryClient = useQueryClient();
  const suggestion = useQuery({
    queryKey: ['admin', 'people', 'suggestion'],
    queryFn: () => get<PersonSuggestion>('/api/admin/people/suggestion'),
    staleTime: 5 * 60_000,
  });
  const [claiming, setClaiming] = useState(false);
  const s = suggestion.data;
  if (!s) return null;

  async function dismiss() {
    if (await attempt(() => request('POST', `/api/admin/people/${s!.id}/dismiss`))) await queryClient.invalidateQueries({ queryKey: ['admin', 'people', 'suggestion'] });
  }

  return (
    <>
      <div className="claim-banner">
        <Avatar baby={{ name: '?', thumbnailUrl: s.thumbnailUrl }} size={64} />
        <div className="claim-text">
          <strong>
            <Sparkles size={16} /> 发现一个出现在 {s.assets.toLocaleString()} 张照片里的人物，是宝宝吗？
          </strong>
          <span className="muted">设为宝宝后，有 TA 的照片都会按年龄自动整理好。</span>
        </div>
        <div className="claim-actions">
          <button className="btn btn-primary" onClick={() => setClaiming(true)}>
            是宝宝
          </button>
          <button className="btn" onClick={dismiss}>
            不是
          </button>
          <PersonPhotosButton person={s} title="是宝宝吗？" />
        </div>
      </div>
      {claiming && <ClaimModal personId={s.id} assets={s.assets} thumbnailUrl={s.thumbnailUrl} onClose={() => setClaiming(false)} />}
    </>
  );
}

export function ClaimModal({ personId, assets, thumbnailUrl, onClose }: { personId: string; assets: number; thumbnailUrl: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [birthday, setBirthday] = useState('');
  const [sex, setSex] = useState<Sex | null>(null);
  const [merging, setMerging] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await request('PUT', `/api/admin/people/${personId}`, { name, birthDate: birthday });
      if (merging.length) await request('POST', `/api/admin/people/${personId}/merge`, { ids: merging });
      const baby = await request<Baby>('POST', '/api/babies', { name, immichPersonId: personId, birthday, sex });
      await queryClient.invalidateQueries();
      navigate(`/baby/${baby.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="设为宝宝"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim() || !birthday} onClick={save}>
            {merging.length ? `保存并合并 ${merging.length} 个人物` : '保存'}
          </button>
        </>
      }
    >
      <div className="person-editor">
        <Avatar baby={{ name: name || '?', thumbnailUrl }} size={120} />
        <div className="form">
          <p className="muted">出现在 {assets.toLocaleString()} 张照片或视频里</p>
          <label className="field">
            <span>名字</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} placeholder="宝宝的小名" autoFocus />
          </label>
          <label className="field">
            <span>生日</span>
            <input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />
          </label>
          <div className="field">
            <span>性别（用于和 WHO 生长标准对比，可以不填）</span>
            <SexPicker value={sex} onChange={setSex} />
          </div>
        </div>
      </div>
      <FaceStrip person={{ id: personId, assets, thumbnailUrl }} title="TA 的照片" size={8} hideAvatar />
      <SimilarPeople personId={personId} name={name || '宝宝'} selected={merging} onChange={setMerging} />
      {error && <div className="error-box">{error}</div>}
    </Modal>
  );
}

/** 可能和这个人物是同一个人的其他人物（从没同框过的），勾选后合并 */
export function SimilarPeople({ personId, name, selected, onChange }: { personId: string; name: string; selected: string[]; onChange: (ids: string[]) => void }) {
  const [comparing, setComparing] = useState<SimilarPerson | null>(null);
  const similar = useQuery({
    queryKey: ['admin', 'people', 'similar', personId],
    queryFn: () => get<SimilarPerson[]>(`/api/admin/people/${personId}/similar`),
    staleTime: 5 * 60_000,
  });
  return (
    <div className="merge-section">
      <h3>
        <Merge size={16} /> 这些可能也是{name}
      </h3>
      <p className="muted">
        宝宝从小到大长相变化很大，常被识别成好几个人物。下面是从没和{name}同框过的人物（同一个人不会和自己同框），按照片数量排序。勾选确实是{name}的，保存时会合并到一起。拿不准的点卡片右上角的照片按钮对比。
      </p>
      {similar.isPending ? (
        <Spinner label="正在比对…" />
      ) : similar.isError ? (
        <ErrorBox error={similar.error} />
      ) : !similar.data.length ? (
        <p className="muted">没有找到可能是同一个人的人物。</p>
      ) : (
        <div className="merge-grid">
          {similar.data.slice(0, 24).map((p) => {
            const on = selected.includes(p.id);
            return (
              <div key={p.id} className={`merge-option ${on ? 'selected' : ''}`}>
                <button type="button" className="merge-option-pick" onClick={() => onChange(on ? selected.filter((x) => x !== p.id) : [...selected, p.id])}>
                  <Avatar baby={{ name: p.name || '?', thumbnailUrl: p.thumbnailUrl }} size={64} />
                  <span>{p.name || '未命名'}</span>
                  <span className="muted">{p.assets} 张</span>
                </button>
                <button type="button" className="merge-option-look" onClick={() => setComparing(p)} title={`看照片，和${name}对比`} aria-label="看照片">
                  <Images size={15} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {comparing && (
        <CompareModal
          person={{ id: personId, thumbnailUrl: `/api/people/${personId}/thumbnail` }}
          name={name}
          other={comparing}
          selected={selected.includes(comparing.id)}
          onPick={(on) => {
            onChange(on ? [...new Set([...selected, comparing.id])] : selected.filter((x) => x !== comparing.id));
            setComparing(null);
          }}
          onClose={() => setComparing(null)}
        />
      )}
    </div>
  );
}

/** 宝宝页（管理员）：还有没命名、可能也是这个宝宝的人物时提示合并 */
export function MergeHint({ baby }: { baby: Baby }) {
  const queryClient = useQueryClient();
  const similar = useQuery({
    queryKey: ['admin', 'people', 'similar', baby.immichPersonId],
    queryFn: () => get<SimilarPerson[]>(`/api/admin/people/${baby.immichPersonId}/similar`),
    staleTime: 10 * 60_000,
  });
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 只提示没命名的（命名过的是别人），照片太少的可能是误识别
  const candidates = (similar.data ?? []).filter((p) => !p.name && p.assets >= 10);
  if (hidden || !candidates.length) return null;

  async function merge() {
    setBusy(true);
    setError(null);
    try {
      await request('POST', `/api/admin/people/${baby.immichPersonId}/merge`, { ids: selected });
      await queryClient.invalidateQueries();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '合并失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="notice notice-info notice-compact">
        <Merge size={16} />
        <button className="link-btn" onClick={() => setOpen(true)}>
          {candidates.length} 个人物可能也是{baby.name}
        </button>
        <button className="link-btn notice-action" onClick={() => setOpen(true)}>
          看看 ›
        </button>
        <button className="icon-btn" onClick={() => setHidden(true)} aria-label="先不看">
          <X size={16} />
        </button>
      </div>
      {open && (
        <Modal
          title={`合并到${baby.name}`}
          onClose={() => setOpen(false)}
          wide
          footer={
            <>
              <span className="spacer" />
              <button className="btn" onClick={() => setOpen(false)}>
                取消
              </button>
              <button className="btn btn-primary" disabled={busy || !selected.length} onClick={merge}>
                合并 {selected.length || ''} 个人物
              </button>
            </>
          }
        >
          <SimilarPeople personId={baby.immichPersonId} name={baby.name} selected={selected} onChange={setSelected} />
          {error && <div className="error-box">{error}</div>}
        </Modal>
      )}
    </>
  );
}
