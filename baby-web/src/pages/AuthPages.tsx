import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, KeyRound, LogOut, Settings, Share, Smartphone, SquarePlus } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { get, request, ROLE_HINTS, ROLE_LABELS, useMe, useSetupStatus, type NotifyPrefs, type Role, type SetupStatus } from '../api';
import { Spinner, Toggle } from '../components/ui';
import { useHealth } from './admin/HealthPage';
import { canPromptInstall, currentSubscription, disablePush, enablePush, isIos, isStandalone, onInstallAvailable, promptInstall, pushSupport } from '../pwa';

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
  const queryClient = useQueryClient();
  const me = useMe();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);
  const { error, busy, submit } = useSubmit(async () => {
    await request('PUT', '/api/auth/password', { current, next });
    setDone(true);
    setCurrent('');
    setNext('');
  });

  async function logout() {
    await request('POST', '/api/auth/logout');
    queryClient.clear();
    window.location.href = '/login';
  }

  const user = me.data;
  return (
    <div className="narrow">
      {user && (
        <section className="me-card">
          <span className="me-avatar">{user.displayName.slice(-1)}</span>
          <div>
            <strong>{user.displayName}</strong>
            <span className="muted">
              {user.username} · {ROLE_LABELS[user.role]}
            </span>
          </div>
        </section>
      )}
      {user?.role === 'admin' && <AdminEntry />}
      <InstallSection />
      <NotificationSection isAdmin={user?.role === 'admin'} />
      <details className="card account-section">
        <summary>
          <KeyRound size={18} /> 修改密码
        </summary>
        <form className="form" onSubmit={submit}>
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
      </details>
      <button className="btn btn-block logout-btn" onClick={logout}>
        <LogOut size={16} />
        退出登录
      </button>
    </div>
  );
}

const ADMIN_LINKS = [
  { to: '/admin/library', label: '照片库', hint: '存储、导入进度' },
  { to: '/admin/people', label: '人物', hint: '宝宝、家人、合并' },
  { to: '/admin/tidy', label: '整理', hint: '重复的照片' },
  { to: '/admin/health', label: '系统状态', hint: '' },
  { to: '/admin/settings', label: '系统设置', hint: '' },
];

/** 管理员：管理后台的入口（底部导航只有 5 项，管理放在“我的”里） */
function AdminEntry() {
  const health = useHealth();
  const problems = health.data?.checks.filter((c) => c.status === 'error' || c.status === 'warn').length ?? 0;
  return (
    <section className="card account-section admin-entry">
      <h2>
        <Settings size={18} /> 管理
      </h2>
      <div className="admin-links">
        {ADMIN_LINKS.map((l) => (
          <Link key={l.to} to={l.to}>
            <strong>{l.label}</strong>
            <span className="muted small">{l.to === '/admin/health' ? (problems ? `${problems} 项需要注意` : '一切正常') : l.hint}</span>
            {l.to === '/admin/health' && problems > 0 && <span className="dot" />}
          </Link>
        ))}
      </div>
    </section>
  );
}

/** 添加到主屏幕：像 App 一样全屏打开 */
function InstallSection() {
  const [, rerender] = useState(0);
  useEffect(() => onInstallAvailable(() => rerender((n) => n + 1)), []);
  if (isStandalone()) return null;
  return (
    <section className="card account-section">
      <h2>
        <Smartphone size={18} /> 添加到手机主屏幕
      </h2>
      <p className="muted">添加后像 App 一样从桌面打开、全屏浏览，还能收到宝宝生日和满月的提醒。</p>
      {canPromptInstall() ? (
        <button className="btn btn-primary" onClick={() => promptInstall().then(() => rerender((n) => n + 1))}>
          <SquarePlus size={16} />
          添加到主屏幕
        </button>
      ) : isIos() ? (
        <ol className="install-steps">
          <li>
            用 Safari 打开这个网址，点底部的 <Share size={16} /> 分享按钮
          </li>
          <li>
            往下找到 <SquarePlus size={16} />“添加到主屏幕”
          </li>
          <li>点右上角“添加”</li>
        </ol>
      ) : (
        <p className="muted">在手机浏览器的菜单里选“添加到主屏幕”或“安装应用”。</p>
      )}
    </section>
  );
}

const PREF_LABELS: { key: keyof NotifyPrefs; label: string; hint: string; adminOnly?: boolean }[] = [
  { key: 'milestones', label: '生日、满月回顾', hint: '那天早上 9 点' },
  { key: 'weekly', label: '每周小结', hint: '周日晚上 8 点：这周拍了多少张宝宝的照片' },
  { key: 'family', label: '家人的点赞、留言', hint: '有人给照片点赞、留言时' },
  { key: 'system', label: '系统提醒', hint: '存储断开、证书快到期、备份失败等', adminOnly: true },
];

/** 想收到哪些提醒（对这个账号的所有设备生效） */
function NotifyPrefsEditor({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const prefs = useQuery({ queryKey: ['push-prefs'], queryFn: () => get<NotifyPrefs>('/api/push/prefs') });
  const weekly = useQuery({ queryKey: ['weekly-preview'], queryFn: () => get<{ title: string; body: string }>('/api/push/weekly-preview'), staleTime: 10 * 60_000 });
  if (!prefs.data) return null;
  async function set(key: keyof NotifyPrefs, value: boolean) {
    queryClient.setQueryData(['push-prefs'], await request<NotifyPrefs>('PUT', '/api/push/prefs', { [key]: value }));
  }
  return (
    <div className="notify-prefs">
      {PREF_LABELS.filter((p) => !p.adminOnly || isAdmin).map((p) => (
        <Toggle key={p.key} checked={prefs.data[p.key]} onChange={(v) => set(p.key, v)} label={p.label} hint={p.key === 'weekly' && weekly.data ? `${p.hint}。这周：${weekly.data.body}` : p.hint} />
      ))}
    </div>
  );
}

/** 生日、满月提醒（推送通知） */
function NotificationSection({ isAdmin }: { isAdmin: boolean }) {
  const support = pushSupport();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    currentSubscription().then((s) => setEnabled(!!s)).catch(() => setEnabled(false));
  }, []);

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage(done);
      setEnabled(!!(await currentSubscription()));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card account-section">
      <h2>
        <Bell size={18} /> 提醒
      </h2>
      <p className="muted">在手机上打开通知后，可以收到宝宝生日和满月的回顾、每周小结、家人的点赞留言。</p>
      {support === 'insecure' ? (
        <p className="muted">需要通过 HTTPS 访问宝宝相册才能接收通知。</p>
      ) : support === 'ios-needs-install' ? (
        <p className="muted">iPhone 上要先把宝宝相册添加到主屏幕（见上面），再从主屏幕打开，才能打开通知。</p>
      ) : support === 'unsupported' ? (
        <p className="muted">这个浏览器不支持通知。</p>
      ) : enabled ? (
        <div className="actions-row">
          <button className="btn" disabled={busy} onClick={() => run(() => request('POST', '/api/push/test'), '已发送一条测试通知')}>
            发一条测试通知
          </button>
          <button className="btn" disabled={busy} onClick={() => run(disablePush, '已关闭这台设备的提醒')}>
            <BellOff size={16} />
            关闭
          </button>
        </div>
      ) : (
        <button className="btn btn-primary" disabled={busy || enabled === null} onClick={() => run(enablePush, '已打开，这台设备会收到提醒')}>
          <Bell size={16} />
          在这台设备上打开提醒
        </button>
      )}
      {message && <p className="muted">{message}</p>}
      <NotifyPrefsEditor isAdmin={isAdmin} />
    </section>
  );
}
