// 家人分享链接（免登录、只读）：只能看到分享里指定的宝宝，以及有这些宝宝出现的照片。
// 设置了访问密码的分享，输对密码后在这个浏览器里记住 30 天；修改密码后需要重新输入

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recordFailure, secureCookie, tooManyFailures } from '../auth.ts';
import { albums, babies, shares, type Share } from '../db.ts';
import { proxyMedia } from '../immich.ts';
import { verifyPassword } from '../password.ts';
import { assetBelongsTo, registerAlbumRoutes, withAge, type AlbumContext } from './album.ts';
import { albumItems } from './albums.ts';

const tokenParams = z.object({ token: z.string().min(10).max(64) });
const personParams = tokenParams.extend({ personId: z.uuid() });
const UNLOCK_SECONDS = 30 * 24 * 3600;

const unlockCookie = (share: Share) => `share_${share.id}`;
/** Cookie 里存密码哈希的摘要：改密码后旧的 Cookie 自动失效 */
const unlockValue = (share: Share) => createHash('sha256').update(share.passwordHash!).digest('base64url').slice(0, 22);

function isUnlocked(req: FastifyRequest, share: Share) {
  if (!share.passwordHash) return true;
  const raw = req.cookies[unlockCookie(share)];
  if (!raw) return false;
  const { valid, value } = req.unsignCookie(raw);
  return valid && value === unlockValue(share);
}

function loadShare(req: FastifyRequest) {
  const { token } = tokenParams.parse(req.params);
  const share = shares.byToken(token);
  if (!share || (share.expiresAt && share.expiresAt < new Date().toISOString())) return null;
  // 分享的是一个相册：相册删了链接就失效
  if (share.albumId !== null) {
    const album = albums.get(share.albumId);
    return album ? { share, babies: [], album } : null;
  }
  // 宝宝被删除后自动从分享中去掉
  const list = share.babyIds.map((id) => babies.get(id)).filter((b) => b !== undefined);
  return list.length ? { share, babies: list, album: null } : null;
}

async function resolve(req: FastifyRequest, reply: FastifyReply): Promise<AlbumContext | null> {
  const found = loadShare(req);
  if (!found) {
    reply.code(404).send({ message: '分享链接无效或已过期' });
    return null;
  }
  if (!isUnlocked(req, found.share)) {
    reply.code(401).send({ message: '请输入访问密码', code: 'SHARE_PASSWORD' });
    return null;
  }
  const { share, album } = found;
  return {
    babies: found.babies,
    // 分享相册：只能看相册里的照片；分享宝宝：只能看有这些宝宝的照片
    canAccessAsset: (assetId) => (album ? Promise.resolve(albums.has(album.id, assetId)) : assetBelongsTo(found.babies, assetId)),
    allowDownload: share.allowDownload,
    searchAll: false,
    family: false,
    // 访客的称呼默认是分享的对象（“爷爷奶奶”），第一次点赞、留言时可以改
    interact: share.allowComments ? { kind: 'share', shareId: share.id, defaultName: share.label } : null,
  };
}

export async function shareRoutes(app: FastifyInstance) {
  app.get('/api/share/:token', async (req, reply) => {
    const found = loadShare(req);
    if (!found) return reply.code(404).send({ message: '分享链接无效或已过期' });
    const { share } = found;
    // 没输密码之前只告诉对方需要密码，不透露宝宝的名字
    if (!isUnlocked(req, share)) return { needsPassword: true };
    const prefix = `/api/share/${share.token}`;
    return {
      needsPassword: false,
      label: share.label,
      expiresAt: share.expiresAt,
      allowDownload: share.allowDownload,
      elderMode: share.elderMode,
      allowComments: share.allowComments,
      album: found.album ? { id: found.album.id, title: found.album.title, description: found.album.description } : null,
      babies: found.babies.map((b) => ({ ...withAge(b), thumbnailUrl: `${prefix}/people/${b.immichPersonId}/thumbnail` })),
    };
  });

  // 分享的相册里的照片
  app.get('/api/share/:token/album', async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const found = loadShare(req)!;
    if (!found.album) return reply.code(404).send({ message: '不存在' });
    return { album: { title: found.album.title, description: found.album.description }, items: await albumItems(found.album.id, async () => true) };
  });

  app.post('/api/share/:token/unlock', async (req, reply) => {
    const found = loadShare(req);
    if (!found) return reply.code(404).send({ message: '分享链接无效或已过期' });
    if (!found.share.passwordHash) return { ok: true };
    if (tooManyFailures(req.ip)) return reply.code(429).send({ message: '尝试次数过多，请 15 分钟后再试' });
    const { password } = z.object({ password: z.string().min(1).max(100) }).parse(req.body);
    if (!(await verifyPassword(password, found.share.passwordHash))) {
      recordFailure(req.ip);
      return reply.code(401).send({ message: '密码不对' });
    }
    reply.setCookie(unlockCookie(found.share), unlockValue(found.share), {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie(req),
      path: `/api/share/${found.share.token}`,
      maxAge: UNLOCK_SECONDS,
    });
    return { ok: true };
  });

  app.get('/api/share/:token/people/:personId/thumbnail', async (req, reply) => {
    const found = loadShare(req);
    const { personId } = personParams.parse(req.params);
    if (!found || !isUnlocked(req, found.share) || !found.babies.some((b) => b.immichPersonId === personId)) {
      return reply.code(404).send({ message: '不存在' });
    }
    return proxyMedia(req, reply, `/people/${personId}/thumbnail`, { cacheSeconds: 3600 });
  });

  registerAlbumRoutes(app, '/api/share/:token', resolve);
}
