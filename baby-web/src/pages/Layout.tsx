import { CircleUser, House, Images, Search, Users } from 'lucide-react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { AlbumContext, ApiError, canEdit, canSeeAllPhotos, useMe, useSetupStatus } from '../api';
import { Spinner } from '../components/ui';

/** 哪些页面属于导航上的哪一项 */
const SECTIONS = {
  photos: ['/photos', '/albums', '/map'],
  family: ['/shares', '/messages', '/members'],
  me: ['/account', '/admin'],
};
const inSection = (path: string, prefixes: string[]) => prefixes.some((p) => path === p || path.startsWith(`${p}/`));

export function Layout() {
  const setup = useSetupStatus();
  const me = useMe();
  const location = useLocation();

  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;
  if (me.isPending || setup.isPending) return <Spinner />;
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  const user = me.data!;
  const path = location.pathname;
  const active = (section: keyof typeof SECTIONS) => (inSection(path, SECTIONS[section]) ? 'active' : '');

  return (
    // 只读成员看不到任何编辑按钮
    <AlbumContext.Provider value={{ base: '/api', readOnly: !canEdit(user), allowDownload: true, interact: {} }}>
      <div className="app">
        <header className="topbar">
          <Link to="/" className="brand">
            <img src="/favicon.svg" alt="" width={28} height={28} />
            宝宝相册
          </Link>
          {/* 只有 5 个入口；手机上在底部 */}
          <nav className="topnav">
            <NavLink to="/" end>
              <House size={20} />
              <span>首页</span>
            </NavLink>
            <NavLink to={canSeeAllPhotos(user) ? '/photos' : '/albums'} className={active('photos')}>
              <Images size={20} />
              <span>照片</span>
            </NavLink>
            <NavLink to="/search">
              <Search size={20} />
              <span>搜索</span>
            </NavLink>
            <NavLink to={canEdit(user) ? '/shares' : '/messages'} className={active('family')}>
              <Users size={20} />
              <span>家人</span>
            </NavLink>
            <NavLink to="/account" className={active('me')} title={user.displayName}>
              <CircleUser size={20} />
              <span>我的</span>
            </NavLink>
          </nav>
        </header>
        <main className="page">
          <Outlet context={user} />
        </main>
      </div>
    </AlbumContext.Provider>
  );
}
