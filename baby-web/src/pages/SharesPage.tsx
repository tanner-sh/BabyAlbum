import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookImage, Check, Copy, Download, ExternalLink, Link2, Lock, MessageCircle, Pencil, Plus, Trash2, Type } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useOutletContext } from 'react-router';
import { canEdit, get, request, useAlbums, useBabies, type Me, type Share } from '../api';
import { FamilyTabs } from '../components/SectionTabs';
import { CopyButton, Empty, ErrorBox, Modal, Spinner, Toggle } from '../components/ui';
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
  const albums = useAlbums();
  const shares = useQuery({ queryKey: ['shares'], queryFn: () => get<Share[]>('/api/shares') });
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Share | 'new' | null>(null);
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
      <FamilyTabs />
      <div className="section-actions">
        <p className="muted">发给家人的链接，不用注册就能看，只能看不能改。给长辈的可以打开“长辈模式”，字和照片更大。</p>
        <button className="btn btn-primary" onClick={() => setEditing('new')} disabled={!babies.data.length}>
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
                    {s.albumId !== null ? `相册：${albums.data?.find((a) => a.id === s.albumId)?.title ?? '…'}` : names(s.babyIds) || '（宝宝已移除）'} · {expired ? '已过期' : s.expiresAt ? `${formatDate(s.expiresAt.slice(0, 10))} 到期` : '永久有效'}
                  </span>
                  <span className="share-flags">
                    {s.hasPassword && (
                      <span className="chip">
                        <Lock size={12} />
                        有密码
                      </span>
                    )}
                    {s.allowDownload && (
                      <span className="chip">
                        <Download size={12} />
                        可下载原图
                      </span>
                    )}
                    {s.elderMode && (
                      <span className="chip">
                        <Type size={12} />
                        长辈模式
                      </span>
                    )}
                    {s.allowComments && (
                      <span className="chip">
                        <MessageCircle size={12} />
                        可点赞留言
                      </span>
                    )}
                    {s.albumId !== null && (
                      <span className="chip">
                        <BookImage size={12} />
                        相册
                      </span>
                    )}
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
                  <button className="icon-btn" onClick={() => setEditing(s)} aria-label="修改">
                    <Pencil size={18} />
                  </button>
                  <button className="icon-btn" onClick={() => remove(s)} aria-label="停用">
                    <Trash2 size={18} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing && <ShareEditor share={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** 新建、修改分享。albumId：分享一个相册（不选宝宝） */
export function ShareEditor({ share, albumId: albumIdProp, defaultLabel, onClose }: { share: Share | null; albumId?: number; defaultLabel?: string; onClose: () => void }) {
  const babies = useBabies();
  const queryClient = useQueryClient();
  const albumId = share ? share.albumId : (albumIdProp ?? null);
  const [label, setLabel] = useState(share?.label ?? (albumId !== null ? '家里人' : '爷爷奶奶'));
  const [allowComments, setAllowComments] = useState(share?.allowComments ?? true);
  const [created, setCreated] = useState<Share | null>(null);
  const [selected, setSelected] = useState<number[]>(share?.babyIds ?? babies.data?.map((b) => b.id) ?? []);
  // 修改时默认保持原来的有效期（-1 表示不改）
  const [days, setDays] = useState(share ? -1 : 0);
  const [usePassword, setUsePassword] = useState(share?.hasPassword ?? false);
  const [password, setPassword] = useState('');
  const [allowDownload, setAllowDownload] = useState(share?.allowDownload ?? false);
  const [elderMode, setElderMode] = useState(share?.elderMode ?? false);
  const [error, setError] = useState<string | null>(null);

  // 新设密码时必须填；原来就有密码的，不填表示不改
  const passwordMissing = usePassword && !password && !share?.hasPassword;

  async function save() {
    setError(null);
    try {
      const keepExpiry = share && days === -1;
      const remainingDays = share?.expiresAt ? Math.max(1, Math.ceil((Date.parse(share.expiresAt) - Date.now()) / 86_400_000)) : undefined;
      const body = {
        label,
        babyIds: selected,
        expiresInDays: keepExpiry ? remainingDays : days || undefined,
        password: !usePassword ? null : password || undefined,
        allowDownload,
        elderMode,
        albumId,
        allowComments,
      };
      if (share) await request('PUT', `/api/shares/${share.id}`, body);
      else {
        const s = await request<Share>('POST', '/api/shares', body);
        await queryClient.invalidateQueries({ queryKey: ['shares'] });
        // 从相册页分享时直接给出链接
        if (albumId !== null) return setCreated(s);
      }
      await queryClient.invalidateQueries({ queryKey: ['shares'] });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  }

  return (
    <Modal
      title={share ? '修改分享' : '新建分享链接'}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          {created ? (
            <button className="btn btn-primary" onClick={onClose}>
              完成
            </button>
          ) : (
            <button className="btn btn-primary" disabled={!label.trim() || (albumId === null && !selected.length) || passwordMissing} onClick={save}>
              {share ? '保存' : '创建'}
            </button>
          )}
        </>
      }
    >
      {created ? (
        <div className="form">
          <p>分享链接已经生成，发给家人就能看到“{defaultLabel}”这个相册：</p>
          <input readOnly value={shareUrl(created)} onFocus={(e) => e.target.select()} />
          <CopyButton text={shareUrl(created)} />
        </div>
      ) : (
      <div className="form">
        <label className="field">
          <span>给谁看</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={50} placeholder="例如：爷爷奶奶" />
        </label>
        {albumId === null && (
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
        )}
        <div className="field">
          <span>有效期{share ? '（从今天重新算）' : ''}</span>
          <div className="chips">
            {share && (
              <button type="button" className={`chip ${days === -1 ? 'chip-accent' : ''}`} onClick={() => setDays(-1)}>
                不改
              </button>
            )}
            {EXPIRY.map((e) => (
              <button key={e.days} type="button" className={`chip ${days === e.days ? 'chip-accent' : ''}`} onClick={() => setDays(e.days)}>
                {e.label}
              </button>
            ))}
          </div>
        </div>
        <Toggle checked={usePassword} onChange={setUsePassword} label="访问密码" hint="打开链接时要先输入密码，适合发到群里的链接" />
        {usePassword && (
          <label className="field">
            <span>{share?.hasPassword ? '新密码（不填表示不改）' : '密码（至少 4 位）'}</span>
            <input value={password} onChange={(e) => setPassword(e.target.value)} minLength={4} maxLength={100} autoComplete="new-password" />
          </label>
        )}
        <Toggle checked={allowDownload} onChange={setAllowDownload} label="允许下载原图" hint="关闭时只能在线看，看不到下载按钮" />
        <Toggle checked={elderMode} onChange={setElderMode} label="长辈模式" hint="字更大、照片更大，适合给爷爷奶奶、外公外婆看" />
        <Toggle checked={allowComments} onChange={setAllowComments} label="允许点赞、留言" hint="对方可以给照片点赞、留言，家里人会收到提醒" />
        {error && <div className="error-box">{error}</div>}
      </div>
      )}
    </Modal>
  );
}
