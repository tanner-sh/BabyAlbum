import { useQuery } from '@tanstack/react-query';
import { Heart, MessageCircle } from 'lucide-react';
import { Link } from 'react-router';
import { get, thumbUrl, useAlbum, type RecentInteraction } from '../api';

/** 首页：家人最近的点赞、留言 */
export function RecentInteractions() {
  const album = useAlbum();
  const recent = useQuery({ queryKey: ['/api', 'social-recent'], queryFn: () => get<RecentInteraction[]>('/api/social/recent'), staleTime: 60_000 });
  const list = (recent.data ?? []).filter((r) => !r.mine);
  if (!list.length) return null;
  return (
    <section className="recent-social">
      <h3>
        <MessageCircle size={18} /> 家人的点赞和留言
      </h3>
      <ul>
        {list.slice(0, 6).map((r, i) => (
          <li key={`${r.assetId}-${r.createdAt}-${i}`}>
            <Link to={`/asset/${r.assetId}`}>
              <img src={thumbUrl(album, r.assetId)} alt="" loading="lazy" />
              <span>
                <strong>{r.name}</strong>
                {r.kind === 'like' ? (
                  <span className="muted">
                    <Heart size={12} fill="currentColor" /> 赞了这张照片
                  </span>
                ) : (
                  <span>{r.text}</span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
