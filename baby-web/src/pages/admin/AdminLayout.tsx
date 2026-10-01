import { Activity, Copy, FolderOpen, SlidersHorizontal, UserRound } from 'lucide-react';
import { Navigate, NavLink, Outlet, useOutletContext } from 'react-router';
import type { Me } from '../../api';

/** 管理后台：只有管理员能进 */
export function AdminLayout() {
  const user = useOutletContext<Me>();
  if (user.role !== 'admin') return <Navigate to="/" replace />;
  return (
    <>
      <nav className="tabs admin-tabs">
        {/* 手机上 5 个标签排成两行，不用左右滑 */}
        <NavLink to="library" className="tab">
          <FolderOpen size={16} />
          照片库
        </NavLink>
        <NavLink to="people" className="tab">
          <UserRound size={16} />
          人物
        </NavLink>
        <NavLink to="tidy" className="tab">
          <Copy size={16} />
          整理
        </NavLink>
        <NavLink to="health" className="tab">
          <Activity size={16} />
          系统状态
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
