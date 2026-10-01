import { useQuery } from '@tanstack/react-query';
import { Link2Off } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router';
import { AlbumContext, get, type ShareInfo } from '../api';
import { BabyView } from '../components/BabyView';
import { Avatar, Empty, Spinner } from '../components/ui';
import { formatDate } from '../format';

/** 家人通过分享链接看到的页面：免登录、只读 */
export function SharePage() {
  const { token } = useParams();
  const [params, setParams] = useSearchParams();
  const base = `/api/share/${token}`;
  const info = useQuery({ queryKey: [base, 'info'], queryFn: () => get<ShareInfo>(base) });

  if (info.isPending) return <Spinner />;
  if (info.isError) {
    return (
      <div className="page">
        <Empty icon={<Link2Off size={48} />} title="链接无效或已过期">
          请联系宝宝的爸爸妈妈重新分享。
        </Empty>
      </div>
    );
  }

  const baby = info.data.babies.find((b) => b.id === Number(params.get('baby'))) ?? info.data.babies[0];

  return (
    <AlbumContext.Provider value={{ base, readOnly: true }}>
      <div className="app share-app">
        <header className="topbar">
          <span className="brand">
            <img src="/favicon.svg" alt="" width={28} height={28} />
            宝宝相册
          </span>
          <span className="muted">分享给{info.data.label}</span>
        </header>
        <main className="page">
          {info.data.babies.length > 1 && (
            <div className="baby-switch">
              {info.data.babies.map((b) => (
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
          <BabyView key={baby.id} baby={baby} />
        </main>
      </div>
    </AlbumContext.Provider>
  );
}
