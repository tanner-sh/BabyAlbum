import { useLocation, useNavigate, useParams } from 'react-router';
import { useAssetInfo, type AlbumItem } from '../api';
import { Lightbox } from '../components/Lightbox';
import { Empty, Spinner } from '../components/ui';

/** 单张照片（从互动提醒、家人留言点进来）：直接打开大图，关掉回到点进来的页面（直接打开的链接就回首页） */
export function AssetPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // 'default' 表示这是打开网站后的第一页，没有可以返回的页面
  const close = () => (location.key !== 'default' ? navigate(-1) : navigate('/', { replace: true }));
  const info = useAssetInfo(id ?? null);
  if (info.isPending) return <Spinner />;
  if (info.isError || !info.data) return <Empty title="找不到这张照片" />;
  const a = info.data;
  const item: AlbumItem = {
    id: a.id,
    type: a.type,
    takenAt: a.takenAt,
    fileName: a.fileName,
    duration: a.duration,
    isFavorite: a.isFavorite,
    width: a.width,
    height: a.height,
    livePhotoVideoId: null,
  };
  return <Lightbox items={[item]} index={0} onIndexChange={() => {}} onClose={close} initialSocial standalone />;
}
