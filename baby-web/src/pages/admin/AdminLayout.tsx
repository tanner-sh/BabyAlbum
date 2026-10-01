import { FolderOpen, SlidersHorizontal, UserRound, Users } from 'lucide-react';
import { Navigate, NavLink, Outlet, useOutletContext } from 'react-router';
import type { Me } from '../../api';

/** 管理后台：只有管理员能进 */
export function AdminLayout() {
  const user = useOutletContext<Me>();
  if (user.role !== 'admin') return <Navigate to="/" replace />;
  return (
    <>
      <nav className="tabs admin-tabs">
        <NavLink to="library" className="tab">
          <FolderOpen size={16} />
          照片库
        </NavLink>
        <NavLink to="people" className="tab">
          <UserRound size={16} />
          人物
        </NavLink>
        <NavLink to="members" className="tab">
          <Users size={16} />
          成员
        </NavLink>
        <NavLink to="settings" className="tab">
          <SlidersHorizontal size={16} />
          系统设置
        </NavLink>
      </nav>
      <Outlet context={user} />
    </>
  );
}
