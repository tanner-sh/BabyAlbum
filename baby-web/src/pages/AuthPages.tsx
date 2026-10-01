import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { get, request, ROLE_HINTS, ROLE_LABELS, useSetupStatus, type Role, type SetupStatus } from '../api';
import { Spinner } from '../components/ui';

// 首次设置、登录、邀请注册、修改密码

function AuthCard({ title, subtitle, children, onSubmit }: { title: string; subtitle?: ReactNode; children: ReactNode; onSubmit: (e: FormEvent) => void }) {
  return (
    <div className="login">
      <form className="login-card" onSubmit={onSubmit}>
        <img src="/favicon.svg" alt="" width={56} height={56} />
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** 提交表单的通用状态 */
function useSubmit(fn: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, submit };
}

function AccountFields({ username, setUsername, displayName, setDisplayName, password, setPassword }: {
  username: string;
  setUsername: (v: string) => void;
  displayName: string;
  setDisplayName: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
}) {
  return (
    <>
      <Field label="称呼（显示给家人看，比如“爸爸”）">
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={30} required autoFocus />
      </Field>
      <Field label="用户名（登录用）">
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" minLength={2} maxLength={32} required />
      </Field>
      <Field label="密码（至少 8 位）">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
      </Field>
    </>
  );
}

/** 首次使用：创建管理员 */
export function SetupPage() {
  const status = useSetupStatus();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  // 刚创建完管理员：不要触发下面“已经设置过就回首页”的跳转，而是进入照片库管理
  const [created, setCreated] = useState(false);
  const { error, busy, submit } = useSubmit(async () => {
    await request('POST', '/api/setup', { username, displayName, password });
    setCreated(true);
    queryClient.setQueryData<SetupStatus>(['setup'], (s) => s && { ...s, needsSetup: false });
    await queryClient.invalidateQueries({ queryKey: ['me'] });
    navigate('/admin/library', { replace: true });
  });

  if (status.isPending || created) return <Spinner />;
  if (status.data && !status.data.needsSetup) return <Navigate to="/" replace />;

  return (
    <AuthCard title="欢迎使用宝宝相册" subtitle="先创建管理员账号，之后可以邀请家人加入" onSubmit={submit}>
      <AccountFields {...{ username, setUsername, displayName, setDisplayName, password, setPassword }} />
      {error && <div className="error-box">{error}</div>}
      <button className="btn btn-primary btn-block" disabled={busy}>
        {busy ? '创建中…' : '创建并进入'}
      </button>
    </AuthCard>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const status = useSetupStatus();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { error, busy, submit } = useSubmit(async () => {
    await request('POST', '/api/auth/login', { username, password });
    await queryClient.invalidateQueries();
    navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });
  });

  if (status.data?.needsSetup) return <Navigate to="/setup" replace />;

  return (
    <AuthCard title="宝宝相册" onSubmit={submit}>
      <Field label="用户名">
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
      </Field>
      <Field label="密码">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </Field>
      {error && <div className="error-box">{error}</div>}
      <button className="btn btn-primary btn-block" disabled={busy}>
        {busy ? '登录中…' : '登录'}
      </button>
      <p className="muted">忘记密码请联系管理员重置</p>
    </AuthCard>
  );
}

/** 通过邀请链接注册 */
export function InvitePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const invite = useQuery({ queryKey: ['invite', token], queryFn: () => get<{ role: Role; note: string }>(`/api/invites/${token}`), retry: false });
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const { error, busy, submit } = useSubmit(async () => {
    await request('POST', '/api/auth/register', { token, username, displayName, password });
    await queryClient.invalidateQueries();
    navigate('/', { replace: true });
  });

  if (invite.isPending) return <Spinner />;
  if (invite.isError) {
    return (
      <AuthCard title="邀请链接无效" subtitle="链接可能已经用过或过期了，请联系管理员重新邀请" onSubmit={(e) => e.preventDefault()}>
        <a className="btn btn-block" href="/login">
          去登录
        </a>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="加入宝宝相册"
      subtitle={
        <>
          你将以“{ROLE_LABELS[invite.data.role]}”身份加入：{ROLE_HINTS[invite.data.role]}
        </>
      }
      onSubmit={submit}
    >
      <AccountFields {...{ username, setUsername, displayName, setDisplayName, password, setPassword }} />
      {error && <div className="error-box">{error}</div>}
      <button className="btn btn-primary btn-block" disabled={busy}>
        {busy ? '创建中…' : '创建账号'}
      </button>
    </AuthCard>
  );
}

/** 我的账号：修改密码 */
export function AccountPage() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);
  const { error, busy, submit } = useSubmit(async () => {
    await request('PUT', '/api/auth/password', { current, next });
    setDone(true);
    setCurrent('');
    setNext('');
  });
  return (
    <div className="narrow">
      <h1>修改密码</h1>
      <form className="form card" onSubmit={submit}>
        <Field label="当前密码">
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label="新密码（至少 8 位）">
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
        </Field>
        {error && <div className="error-box">{error}</div>}
        {done && <div className="success-box">密码已修改，其他设备上的登录已失效</div>}
        <button className="btn btn-primary" disabled={busy}>
          保存
        </button>
      </form>
    </div>
  );
}
