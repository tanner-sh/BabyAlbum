import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Heart, Send, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { get, request, useAlbum, type Social } from '../api';
import { formatServerTime } from '../format';
import { useConfirm } from './ui';

// 家人互动：点赞、留言。登录的家人用自己的称呼；分享链接的访客第一次互动时填一个称呼，浏览器会记住

const nameKey = (base: string) => `baby-album:visitor-name:${base}`;
const loadName = (base: string) => {
  try {
    return localStorage.getItem(nameKey(base));
  } catch {
    return null;
  }
};
const saveName = (base: string, name: string) => {
  try {
    localStorage.setItem(nameKey(base), name);
  } catch {
    // 隐私模式下存不了，下次再问
  }
};

export function useSocial(assetId: string) {
  const album = useAlbum();
  return useQuery({
    queryKey: [album.base, 'social', assetId],
    queryFn: () => get<Social>(`${album.base}/assets/${assetId}/social`),
    enabled: !!album.interact,
    staleTime: 30_000,
  });
}

/** 大图旁边的点赞、留言面板 */
export function SocialPanel({ assetId }: { assetId: string }) {
  const album = useAlbum();
  const queryClient = useQueryClient();
  const social = useSocial(assetId);
  const isVisitor = album.base !== '/api';
  const [name, setName] = useState(() => (isVisitor ? (loadName(album.base) ?? (album.interact ? album.interact.visitorName : undefined) ?? '') : ''));
  const [askName, setAskName] = useState(isVisitor && !loadName(album.base));
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(path: string, body: object) {
    setError(null);
    setBusy(true);
    try {
      if (isVisitor) {
        if (!name.trim()) throw new Error('先填一下怎么称呼你');
        saveName(album.base, name.trim());
        setAskName(false);
      }
      const data = await request<Social>('POST', `${album.base}/assets/${assetId}/${path}`, { ...body, name: isVisitor ? name.trim() : undefined });
      queryClient.setQueryData([album.base, 'social', assetId], data);
      void queryClient.invalidateQueries({ queryKey: ['/api', 'social-recent'] });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '没发出去');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim() && (await send('comments', { text: text.trim() }))) setText('');
  }

  const [ask, confirmDialog] = useConfirm();
  function remove(id: number) {
    ask({
      title: '删除留言',
      message: '删除这条留言？',
      confirmLabel: '删除',
      danger: true,
      action: async () => {
        await request('DELETE', `${album.base}/comments/${id}`);
        await queryClient.invalidateQueries({ queryKey: [album.base, 'social', assetId] });
      },
    });
  }

  if (!album.interact) return null;
  const data = social.data;
  const liked = data?.likes.some((l) => l.mine) ?? false;

  return (
    <div className="social">
      <div className="social-likes">
        <button className={`like-btn ${liked ? 'liked' : ''}`} disabled={busy} onClick={() => send('like', {})} aria-pressed={liked}>
          <Heart size={18} fill={liked ? 'currentColor' : 'none'} />
          {liked ? '已赞' : '赞'}
        </button>
        {data && data.likes.length > 0 && <span className="muted">{data.likes.map((l) => l.name).join('、')} 觉得很赞</span>}
      </div>
      {data && data.comments.length > 0 && (
        <ul className="comments">
          {data.comments.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong>
              <span>{c.text}</span>
              <time className="muted">{formatServerTime(c.createdAt, { withYear: false })}</time>
              {c.canDelete && (
                <button className="icon-btn" onClick={() => remove(c.id)} aria-label="删除留言">
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {askName && (
        <label className="field social-name">
          <span>怎么称呼你？（家里人会看到）</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} placeholder="比如：奶奶" />
        </label>
      )}
      <form className="comment-form" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="说点什么…" enterKeyHint="send" />
        <button className="btn btn-primary" disabled={busy || !text.trim()} aria-label="发送">
          <Send size={16} />
        </button>
      </form>
      {isVisitor && !askName && name && (
        <button className="link-btn muted small" onClick={() => setAskName(true)}>
          以“{name}”的身份留言，改一下
        </button>
      )}
      {error && <div className="error-box">{error}</div>}
      {confirmDialog}
    </div>
  );
}
