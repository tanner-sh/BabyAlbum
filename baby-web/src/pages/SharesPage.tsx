import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, Link2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useOutletContext } from 'react-router';
import { canEdit, get, request, useBabies, type Me, type Share } from '../api';
import { Empty, ErrorBox, Modal, Spinner } from '../components/ui';
import { formatDate } from '../format';

const EXPIRY = [
  { days: 0, label: '永久' },
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' },
  { days: 365, label: '1 年' },
];

const shareUrl = (s: Share) => `${window.location.origin}/s/${s.token}`;

/** 家人分享：生成免登录的只读链接，发给爷爷奶奶等家人 */
export function SharesPage() {
  const me = useOutletContext<Me>();
  if (!canEdit(me)) return <Navigate to="/" replace />;
  return <SharesList />;
}

function SharesList() {
  const babies = useBabies();
  const shares = useQuery({ queryKey: ['shares'], queryFn: () => get<Share[]>('/api/shares') });
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);

  if (shares.isPending || babies.isPending) return <Spinner />;
  if (shares.isError) return <ErrorBox error={shares.error} />;
  if (babies.isError) return <ErrorBox error={babies.error} />;

  const names = (ids: number[]) =>
    ids
      .map((id) => babies.data.find((b) => b.id === id)?.name)
      .filter(Boolean)
      .join('、');

  async function copy(s: Share) {
    await navigator.clipboard.writeText(shareUrl(s)).catch(() => prompt('复制这个链接', shareUrl(s)));
    setCopied(s.id);
    setTimeout(() => setCopied(null), 2000);
  }

  async function remove(s: Share) {
    if (!confirm(`停用“${s.label}”的分享链接？停用后对方将无法再打开。`)) return;
    await request('DELETE', `/api/shares/${s.id}`);
    await queryClient.invalidateQueries({ queryKey: ['shares'] });
  }

  return (
    <>
      <div className="section-actions">
        <div>
          <h1>家人分享</h1>
          <p className="muted">生成一个链接发给家人，不用注册登录就能看宝宝的照片。对方只能看到有宝宝的照片，不能修改任何内容。</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)} disabled={!babies.data.length}>
          <Plus size={16} />
          新建分享
        </button>
      </div>
      {!shares.data.length ? (
        <Empty icon={<Link2 size={40} />} title="还没有分享链接" />
      ) : (
        <ul className="share-list">
          {shares.data.map((s) => {
            const expired = !!s.expiresAt && s.expiresAt < new Date().toISOString();
            return (
              <li key={s.id} className={`share-item ${expired ? 'expired' : ''}`}>
                <div>
                  <strong>{s.label}</strong>
                  <span className="muted">
                    {names(s.babyIds) || '（宝宝已移除）'} · {expired ? '已过期' : s.expiresAt ? `${formatDate(s.expiresAt.slice(0, 10))} 到期` : '永久有效'}
                  </span>
                </div>
                <div className="share-actions">
                  <button className="btn" onClick={() => copy(s)} disabled={expired}>
                    {copied === s.id ? <Check size={16} /> : <Copy size={16} />}
                    {copied === s.id ? '已复制' : '复制链接'}
                  </button>
                  <a className="icon-btn" href={shareUrl(s)} target="_blank" rel="noreferrer" aria-label="打开">
                    <ExternalLink size={18} />
                  </a>
                  <button className="icon-btn" onClick={() => remove(s)} aria-label="停用">
                    <Trash2 size={18} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {creating && <CreateShareModal onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateShareModal({ onClose }: { onClose: () => void }) {
  const babies = useBabies();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('爷爷奶奶');
  const [selected, setSelected] = useState<number[]>(babies.data?.map((b) => b.id) ?? []);
  const [days, setDays] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    try {
      await request('POST', '/api/shares', { label, babyIds: selected, expiresInDays: days || undefined });
      await queryClient.invalidateQueries({ queryKey: ['shares'] });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
    }
  }

  return (
    <Modal
      title="新建分享链接"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!label.trim() || !selected.length} onClick={save}>
            创建
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span>给谁看</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={50} placeholder="例如：爷爷奶奶" />
        </label>
        <div className="field">
          <span>分享哪些宝宝</span>
          <div className="chips">
            {babies.data?.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`chip ${selected.includes(b.id) ? 'chip-accent' : ''}`}
                onClick={() => setSelected((s) => (s.includes(b.id) ? s.filter((x) => x !== b.id) : [...s, b.id]))}
              >
                {b.name}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>有效期</span>
          <div className="chips">
            {EXPIRY.map((e) => (
              <button key={e.days} type="button" className={`chip ${days === e.days ? 'chip-accent' : ''}`} onClick={() => setDays(e.days)}>
                {e.label}
              </button>
            ))}
          </div>
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>
    </Modal>
  );
}
