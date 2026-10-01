import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2Off, Lock, Search, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { AlbumContext, get, request, type ShareInfo } from '../api';
import { BabyView } from '../components/BabyView';
import { SearchBox, SearchResults } from '../components/SearchResults';
import { Avatar, Empty, Spinner } from '../components/ui';
import { formatDate } from '../format';

/** 家人通过分享链接看到的页面：免登录、只读。可以设访问密码、长辈模式（大字大图） */
export function SharePage() {
  const { token } = useParams();
  const [params, setParams] = useSearchParams();
  const base = `/api/share/${token}`;
  const info = useQuery({ queryKey: [base, 'info'], queryFn: () => get<ShareInfo>(base) });
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState('');

  if (info.isPending) return <Spinner />;
  if (info.isError) {
    return (
      <div className="page">
        <Empty icon={<Link2Off size={48} />} title="链接无效或已过期">
          请联系分享给你的人重新分享。
        </Empty>
      </div>
    );
  }
  if (info.data.needsPassword) return <PasswordGate base={base} />;

  const data = info.data;
  const baby = data.babies.find((b) => b.id === Number(params.get('baby'))) ?? data.babies[0];

  return (
    <AlbumContext.Provider value={{ base, readOnly: true, allowDownload: data.allowDownload }}>
      <div className={`app share-app ${data.elderMode ? 'elder' : ''}`}>
        <header className="topbar">
          <span className="brand">
            <img src="/favicon.svg" alt="" width={28} height={28} />
            宝宝相册
          </span>
          <span className="muted">分享给{data.label}</span>
          <button className="icon-btn" onClick={() => setSearching((v) => !v)} aria-label={searching ? '关闭搜索' : '搜索'}>
            {searching ? <X size={20} /> : <Search size={20} />}
          </button>
        </header>
        <main className="page">
          {data.babies.length > 1 && (
            <div className="baby-switch">
              {data.babies.map((b) => (
                <button key={b.id} className={`baby-switch-item ${b.id === baby.id ? 'active' : ''}`} onClick={() => setParams({ baby: String(b.id) })}>
                  <Avatar baby={b} size={40} />
                  {b.name}
                </button>
              ))}
            </div>
          )}
          <header className="baby-header">
            <Avatar baby={baby} size={64} />
            <div>
              <h1>{baby.name}</h1>
              <p className="baby-age">今天 {baby.ageLabel}</p>
              <p className="muted">{formatDate(baby.birthday)} 出生</p>
            </div>
          </header>
          {searching ? (
            <section className="share-search">
              <SearchBox value={q} onSearch={setQ} autoFocus />
              <SearchResults q={q} babyId={baby.id} />
            </section>
          ) : (
            <BabyView key={baby.id} baby={baby} />
          )}
        </main>
      </div>
    </AlbumContext.Provider>
  );
}

function PasswordGate({ base }: { base: string }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await request('POST', `${base}/unlock`, { password });
      await queryClient.invalidateQueries({ queryKey: [base] });
    } catch (err) {
      setError(err instanceof Error ? err.message : '出错了');
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <Lock size={40} className="login-icon" />
        <h1>请输入访问密码</h1>
        <p className="muted">这个相册设置了密码，向分享给你的人要一下。输对一次后，这台设备 30 天内不用再输。</p>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required autoComplete="off" />
        {error && <div className="error-box">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy || !password}>
          打开相册
        </button>
      </form>
    </div>
  );
}
