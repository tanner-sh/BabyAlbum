import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Link2, Pencil, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useOutletContext } from 'react-router';
import { get, request, ROLE_HINTS, ROLE_LABELS, useBabies, type AdminInvite, type AdminUser, type Me, type Role } from '../../api';
import { FamilyTabs } from '../../components/SectionTabs';
import { BabyAccessPicker, CopyButton, ErrorBox, Modal, Spinner, Toggle } from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';

const ROLES: Role[] = ['admin', 'member', 'viewer'];
const inviteUrl = (token: string) => `${window.location.origin}/invite/${token}`;

/** 成员管理（在“家人”里，只有管理员能进）：账号、角色、能看哪些宝宝、邀请链接 */
export function MembersPage() {
  const me = useOutletContext<Me>();
  if (me.role !== 'admin') return <Navigate to="/" replace />;
  return (
    <>
      <FamilyTabs />
      <MembersList />
    </>
  );
}

function MembersList() {
  const me = useOutletContext<Me>();
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => get<AdminUser[]>('/api/admin/users') });
  const invites = useQuery({ queryKey: ['admin', 'invites'], queryFn: () => get<AdminInvite[]>('/api/admin/invites') });
  const babies = useBabies();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<AdminUser | 'new' | null>(null);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [inviting, setInviting] = useState(false);

  const babyNames = (ids: number[] | null) => (ids === null ? '全部宝宝' : ids.map((id) => babies.data?.find((b) => b.id === id)?.name ?? '?').join('、'));

  async function remove(u: AdminUser) {
    if (!confirm(`删除成员“${u.displayName}”？`)) return;
    try {
      await request('DELETE', `/api/admin/users/${u.id}`);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    } catch (e) {
      alert(e instanceof Error ? e.message : '删除失败');
    }
  }

  async function removeInvite(token: string) {
    await request('DELETE', `/api/admin/invites/${token}`);
    await queryClient.invalidateQueries({ queryKey: ['admin', 'invites'] });
  }

  if (users.isPending || babies.isPending) return <Spinner />;
  if (users.isError) return <ErrorBox error={users.error} />;

  const pending = invites.data?.filter((i) => !i.usedBy && !i.expired) ?? [];

  return (
    <div className="admin-page">
      <div className="section-actions">
        <p className="muted">家人的账号。管理员：{ROLE_HINTS.admin}；家人：{ROLE_HINTS.member}；只读：{ROLE_HINTS.viewer}。</p>
        <div className="share-actions">
          <button className="btn btn-primary" onClick={() => setInviting(true)}>
            <Link2 size={16} />
            邀请家人
          </button>
          <button className="btn" onClick={() => setEditing('new')}>
            <UserPlus size={16} />
            直接创建
          </button>
        </div>
      </div>

      <ul className="share-list">
        {users.data.map((u) => (
          <li key={u.id} className={`share-item ${u.disabled ? 'expired' : ''}`}>
            <div>
              <strong>
                {u.displayName} <span className="muted">@{u.username}</span>
                {u.id === me.id && <span className="badge">我</span>}
                {u.disabled && <span className="badge">已停用</span>}
              </strong>
              <span className="muted">
                {ROLE_LABELS[u.role]}
                {u.role !== 'admin' && ` · ${babyNames(u.babyIds)}`} · {u.lastLoginAt ? `最近登录 ${formatDateTime(u.lastLoginAt.replace(' ', 'T'))}` : '还没登录过'}
              </span>
            </div>
            <div className="share-actions">
              <button className="icon-btn" onClick={() => setEditing(u)} aria-label="编辑">
                <Pencil size={18} />
              </button>
              <button className="icon-btn" onClick={() => setResetting(u)} aria-label="重置密码" title="重置密码">
                <KeyRound size={18} />
              </button>
              {u.id !== me.id && (
                <button className="icon-btn" onClick={() => remove(u)} aria-label="删除">
                  <Trash2 size={18} />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {pending.length > 0 && (
        <section>
          <h3>还没使用的邀请链接</h3>
          <ul className="share-list">
            {pending.map((i) => (
              <li key={i.token} className="share-item">
                <div>
                  <strong>{i.note || '邀请'}</strong>
                  <span className="muted">
                    {ROLE_LABELS[i.role]}
                    {i.role !== 'admin' && ` · ${babyNames(i.babyIds)}`} · {formatDate(i.expiresAt.slice(0, 10))} 前有效
                  </span>
                </div>
                <div className="share-actions">
                  <CopyButton text={inviteUrl(i.token)} />
                  <button className="icon-btn" onClick={() => removeInvite(i.token)} aria-label="作废">
                    <Trash2 size={18} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {editing && <UserEditor user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {resetting && <ResetPassword user={resetting} onClose={() => setResetting(null)} />}
      {inviting && <InviteCreator onClose={() => setInviting(false)} />}
    </div>
  );
}

function RolePicker({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  return (
    <div className="role-picker">
      {ROLES.map((r) => (
        <button key={r} type="button" className={`role-option ${value === r ? 'selected' : ''}`} onClick={() => onChange(r)}>
          <strong>{ROLE_LABELS[r]}</strong>
          <span className="muted">{ROLE_HINTS[r]}</span>
        </button>
      ))}
    </div>
  );
}

function UserEditor({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const babies = useBabies();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(user?.role ?? 'member');
  const [babyIds, setBabyIds] = useState<number[] | null>(user?.babyIds ?? null);
  const [disabled, setDisabled] = useState(user?.disabled ?? false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      const access = role === 'admin' ? null : babyIds;
      if (user) await request('PATCH', `/api/admin/users/${user.id}`, { displayName, role, babyIds: access, disabled });
      else await request('POST', '/api/admin/users', { username, displayName, password, role, babyIds: access });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  }

  return (
    <Modal
      title={user ? `编辑 ${user.displayName}` : '创建成员'}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!displayName.trim() || (!user && (!username.trim() || password.length < 8))}>
            保存
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span>称呼</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={30} placeholder="比如：妈妈、奶奶" />
        </label>
        {!user && (
          <>
            <label className="field">
              <span>用户名（登录用）</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={32} autoComplete="off" />
            </label>
            <label className="field">
              <span>初始密码（至少 8 位，告诉对方后建议让他自己改）</span>
              <input value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
          </>
        )}
        <div className="field">
          <span>角色</span>
          <RolePicker value={role} onChange={setRole} />
        </div>
        {role !== 'admin' && babies.data && (
          <div className="field">
            <span>能看哪些宝宝</span>
            <BabyAccessPicker babies={babies.data} value={babyIds} onChange={setBabyIds} />
          </div>
        )}
        {user && <Toggle checked={disabled} onChange={setDisabled} label="停用" hint="停用后立即退出登录，也不能再登录" />}
        {error && <div className="error-box">{error}</div>}
      </div>
    </Modal>
  );
}

function ResetPassword({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function save() {
    try {
      await request('PUT', `/api/admin/users/${user.id}/password`, { password });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  }
  return (
    <Modal
      title={`重置 ${user.displayName} 的密码`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={password.length < 8} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span>新密码（至少 8 位）</span>
          <input value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
        </label>
        <p className="muted">保存后，对方在所有设备上的登录都会失效，需要用新密码重新登录。</p>
        {error && <div className="error-box">{error}</div>}
      </div>
    </Modal>
  );
}

function InviteCreator({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const babies = useBabies();
  const [note, setNote] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [babyIds, setBabyIds] = useState<number[] | null>(null);
  const [days, setDays] = useState(7);
  const [created, setCreated] = useState<AdminInvite | null>(null);

  async function create() {
    const invite = await request<AdminInvite>('POST', '/api/admin/invites', { note, role, babyIds: role === 'admin' ? null : babyIds, expiresInDays: days });
    await queryClient.invalidateQueries({ queryKey: ['admin', 'invites'] });
    setCreated(invite);
  }

  return (
    <Modal
      title="邀请家人"
      onClose={onClose}
      footer={
        created ? (
          <>
            <span className="spacer" />
            <button className="btn btn-primary" onClick={onClose}>
              完成
            </button>
          </>
        ) : (
          <>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button className="btn btn-primary" onClick={create}>
              生成邀请链接
            </button>
          </>
        )
      }
    >
      {created ? (
        <div className="form">
          <p>把这个链接发给对方，打开后设置自己的用户名和密码即可。链接只能用一次，{days} 天内有效。</p>
          <input readOnly value={inviteUrl(created.token)} onFocus={(e) => e.target.select()} />
          <CopyButton text={inviteUrl(created.token)} />
        </div>
      ) : (
        <div className="form">
          <label className="field">
            <span>备注（给自己看，比如“妈妈”）</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={50} />
          </label>
          <div className="field">
            <span>角色</span>
            <RolePicker value={role} onChange={setRole} />
          </div>
          {role !== 'admin' && babies.data && (
            <div className="field">
              <span>能看哪些宝宝</span>
              <BabyAccessPicker babies={babies.data} value={babyIds} onChange={setBabyIds} />
            </div>
          )}
          <div className="field">
            <span>有效期</span>
            <div className="chips">
              {[1, 7, 30].map((d) => (
                <button key={d} type="button" className={`chip ${days === d ? 'chip-accent' : ''}`} onClick={() => setDays(d)}>
                  {d} 天
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
