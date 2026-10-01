import { useQueryClient } from '@tanstack/react-query';
import { Columns2, House, KeyRound, LogOut, Settings, Share2 } from 'lucide-react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { AlbumContext, ApiError, canEdit, request, ROLE_LABELS, useMe, useSetupStatus } from '../api';
import { Spinner } from '../components/ui';

export function Layout() {
  const setup = useSetupStatus();
  const me = useMe();
  const location = useLocation();
  const queryClient = useQueryClient();

  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;
  if (me.isPending || setup.isPending) return <Spinner />;
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  const user = me.data!;

  async function logout() {
    await request('POST', '/api/auth/logout');
    queryClient.clear();
    window.location.href = '/login';
  }

  return (
    // 只读成员看不到任何编辑按钮
    <AlbumContext.Provider value={{ base: '/api', readOnly: !canEdit(user) }}>
      <div className="app">
        <header className="topbar">
          <Link to="/" className="brand">
            <img src="/favicon.svg" alt="" width={28} height={28} />
            宝宝相册
          </Link>
          <nav className="topnav">
            <NavLink to="/" end>
              <House size={18} />
              <span>首页</span>
            </NavLink>
            <NavLink to="/compare">
              <Columns2 size={18} />
              <span>同龄对比</span>
            </NavLink>
            {canEdit(user) && (
              <NavLink to="/shares">
                <Share2 size={18} />
                <span>分享</span>
              </NavLink>
            )}
            {user.role === 'admin' && (
              <NavLink to="/admin">
                <Settings size={18} />
                <span>管理</span>
              </NavLink>
            )}
            <NavLink to="/account" className="user-chip" title={`${user.displayName}（${ROLE_LABELS[user.role]}）· 修改密码`}>
              <KeyRound size={16} />
              <span>{user.displayName}</span>
            </NavLink>
            <button className="icon-btn" onClick={logout} title="退出登录" aria-label="退出登录">
              <LogOut size={18} />
            </button>
          </nav>
        </header>
        <main className="page">
          <Outlet context={user} />
        </main>
      </div>
    </AlbumContext.Provider>
  );
}
