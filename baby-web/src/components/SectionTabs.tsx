import { BookImage, Images, Link2, Map as MapIcon, MessageCircle, Users } from 'lucide-react';
import { NavLink, useOutletContext } from 'react-router';
import { canEdit, canSeeAllPhotos, type Me } from '../api';

// 底部导航只有 5 个入口，同一类的页面在页面顶部切换

/** 照片：全部照片（能看所有照片的人才有）、相册、地图 */
export function PhotosTabs() {
  const me = useOutletContext<Me>();
  return (
    <nav className="tabs section-tabs">
      {canSeeAllPhotos(me) && (
        <NavLink to="/photos" className="tab" end>
          <Images size={16} />
          全部照片
        </NavLink>
      )}
      <NavLink to="/albums" className="tab">
        <BookImage size={16} />
        相册
      </NavLink>
      <NavLink to="/map" className="tab">
        <MapIcon size={16} />
        地图
      </NavLink>
    </nav>
  );
}

/** 家人：分享链接（能编辑的人）、家人的点赞留言、成员（管理员） */
export function FamilyTabs() {
  const me = useOutletContext<Me>();
  return (
    <nav className="tabs section-tabs">
      {canEdit(me) && (
        <NavLink to="/shares" className="tab">
          <Link2 size={16} />
          分享链接
        </NavLink>
      )}
      <NavLink to="/messages" className="tab">
        <MessageCircle size={16} />
        留言
      </NavLink>
      {me.role === 'admin' && (
        <NavLink to="/members" className="tab">
          <Users size={16} />
          成员
        </NavLink>
      )}
    </nav>
  );
}
