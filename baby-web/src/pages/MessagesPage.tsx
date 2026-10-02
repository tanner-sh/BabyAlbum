import { useQuery } from '@tanstack/react-query';
import { Heart, MessageCircle } from 'lucide-react';
import { Link } from 'react-router';
import { get, thumbUrl, useAlbum, type RecentInteraction } from '../api';
import { FamilyTabs } from '../components/SectionTabs';
import { Empty, ErrorBox, Spinner } from '../components/ui';
import { formatServerTime } from '../format';

/** 家人的点赞、留言（包括分享链接的访客） */
export function MessagesPage() {
  const album = useAlbum();
  const recent = useQuery({ queryKey: ['/api', 'social-recent', 100], queryFn: () => get<RecentInteraction[]>('/api/social/recent?limit=100') });
  return (
    <>
      <FamilyTabs />
      {recent.isPending ? (
        <Spinner />
      ) : recent.isError ? (
        <ErrorBox error={recent.error} />
      ) : !recent.data.length ? (
        <Empty icon={<MessageCircle size={40} />} title="还没有留言">
          家人看照片时可以点赞、留言，分享链接的访客也可以。
        </Empty>
      ) : (
        <ul className="message-list">
          {recent.data.map((r, i) => (
            <li key={`${r.assetId}-${r.createdAt}-${i}`}>
              <Link to={`/asset/${r.assetId}`}>
                <img src={thumbUrl(album, r.assetId)} alt="" loading="lazy" />
                <span>
                  <strong>{r.mine ? '我' : r.name}</strong>
                  {r.kind === 'like' ? (
                    <span className="muted">
                      <Heart size={12} fill="currentColor" /> 赞了这张照片
                    </span>
                  ) : (
                    <span>{r.text}</span>
                  )}
                  <time className="muted small">{formatServerTime(r.createdAt)}</time>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
