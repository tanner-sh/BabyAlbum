import { useQuery } from '@tanstack/react-query';
import { Images, Play, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { get, type PersonFace } from '../api';
import { formatDate } from '../format';
import { Lightbox } from './Lightbox';
import { Avatar, ErrorBox, Modal, Spinner } from './ui';

// 人脸识别出来的人物，头像经常很糊（侧脸、远处、合影里的小脸），光看头像认不出是谁。
// 这里随机取几张有 TA 的照片，把脸裁出来给人看（只有管理员能用）

/** 照片数量不知道时可以不传 */
type PersonRef = { id: string; assets?: number; thumbnailUrl: string };

/** “看照片”按钮 + 弹窗：认人用 */
export function PersonPhotosButton({ person, title = '这是谁？', label = '看照片' }: { person: PersonRef; title?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
        <Images size={14} /> {label}
      </button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)} wide>
          <FaceStrip person={person} title="TA 的照片" size={16} hideAvatar />
        </Modal>
      )}
    </>
  );
}

/** 合并前对比：两边各随机取几张照片，只看脸，判断是不是同一个人 */
export function CompareModal({
  person,
  name,
  other,
  selected,
  onPick,
  onClose,
}: {
  person: PersonRef;
  name: string;
  other: PersonRef & { name: string };
  selected: boolean;
  onPick: (on: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="是同一个人吗？"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="spacer" />
          {selected ? (
            <button className="btn" onClick={() => onPick(false)}>
              不是，取消勾选
            </button>
          ) : (
            <button className="btn" onClick={onClose}>
              不是
            </button>
          )}
          <button className="btn btn-primary" onClick={() => onPick(true)}>
            是同一个人，勾选合并
          </button>
        </>
      }
    >
      <FaceStrip person={person} title={name} size={8} />
      <FaceStrip person={other} title={other.name || '未命名'} size={16} />
    </Modal>
  );
}

/** 随机几张有这个人物的照片，只显示 TA 的脸；可以换一批，点开看整张 */
export function FaceStrip({ person, title, size, hideAvatar }: { person: PersonRef; title: string; size: number; hideAvatar?: boolean }) {
  const faces = useQuery({
    queryKey: ['admin', 'people', 'faces', person.id, size],
    queryFn: () => get<PersonFace[]>(`/api/admin/people/${person.id}/faces?size=${size}`),
    staleTime: Infinity,
  });
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section className="face-strip">
      <div className="face-strip-head">
        {!hideAvatar && <Avatar baby={{ name: title, thumbnailUrl: person.thumbnailUrl }} size={32} />}
        <strong>{title}</strong>
        {person.assets !== undefined && <span className="muted">{person.assets.toLocaleString()} 张</span>}
        <span className="spacer" />
        <button className="btn btn-small" disabled={faces.isFetching} onClick={() => faces.refetch()}>
          <RefreshCw size={14} /> 换一批
        </button>
      </div>
      {faces.isPending ? (
        <Spinner label="正在找照片…" />
      ) : faces.isError ? (
        <ErrorBox error={faces.error} />
      ) : !faces.data.length ? (
        <p className="muted">没有找到照片</p>
      ) : (
        <div className="face-grid">
          {faces.data.map((f, i) => (
            <FaceCrop key={f.id} face={f} onClick={() => setOpen(i)} />
          ))}
        </div>
      )}
      {open !== null && faces.data && (
        // 盖在人物弹窗上面
        <div className="lightbox-layer">
          <Lightbox items={faces.data} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />
        </div>
      )}
    </section>
  );
}

/** 从照片里裁出这个人的脸（留一些边，能看到发型和脸型）；找不到脸的位置就显示整张照片 */
function FaceCrop({ face, onClick }: { face: PersonFace; onClick: () => void }) {
  const url = `/api/assets/${face.id}/thumbnail?size=preview`;
  // 拍摄时间是当地时间，不能用 new Date（会当成 UTC 再换算）
  const isVideo = face.type === 'VIDEO';
  const title = `${formatDate(face.takenAt)}，${isVideo ? '点开播放视频' : '点开看整张照片'}`;
  // 有的人物只出现在视频里（人脸是从视频封面认出来的），标出来
  const badge = isVideo && (
    <span className="face-crop-video">
      <Play size={12} fill="currentColor" />
    </span>
  );
  if (!face.box)
    return (
      <button type="button" className="face-crop" onClick={onClick} title={title} style={{ backgroundImage: `url(${url})`, backgroundSize: 'cover', backgroundPosition: 'center' }}>
        {badge}
      </button>
    );
  const { x, y, w, h, ratio } = face.box;
  // 以照片高度为 1，宽度为 ratio；取一个包住脸、放大 1.8 倍的正方形，不超出照片
  const side = Math.min(Math.max(w * ratio, h) * 1.8, ratio, 1);
  const sw = side / ratio;
  const sh = side;
  const left = Math.min(Math.max(x + w / 2 - sw / 2, 0), 1 - sw);
  const top = Math.min(Math.max(y + h / 2 - sh / 2, 0), 1 - sh);
  const pos = (start: number, span: number) => (span >= 1 ? 0 : (start / (1 - span)) * 100);
  return (
    <button
      type="button"
      className="face-crop"
      onClick={onClick}
      title={title}
      style={{
        backgroundImage: `url(${url})`,
        backgroundSize: `${100 / sw}% ${100 / sh}%`,
        backgroundPosition: `${pos(left, sw)}% ${pos(top, sh)}%`,
      }}
    >
      {badge}
    </button>
  );
}
