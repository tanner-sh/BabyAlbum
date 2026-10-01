// 家人分享链接（免登录、只读）：只能看到分享里指定的宝宝，以及有这些宝宝出现的照片

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { babies, shares } from '../db.ts';
import { proxyMedia } from '../immich.ts';
import { assetBelongsTo, registerAlbumRoutes, withAge, type AlbumContext } from './album.ts';

const tokenParams = z.object({ token: z.string().min(10).max(64) });
const personParams = tokenParams.extend({ personId: z.uuid() });

function loadShare(req: FastifyRequest) {
  const { token } = tokenParams.parse(req.params);
  const share = shares.byToken(token);
  if (!share || (share.expiresAt && share.expiresAt < new Date().toISOString())) return null;
  // 宝宝被删除后自动从分享中去掉
  const list = share.babyIds.map((id) => babies.get(id)).filter((b) => b !== undefined);
  return list.length ? { share, babies: list } : null;
}

async function resolve(req: FastifyRequest, reply: FastifyReply): Promise<AlbumContext | null> {
  const found = loadShare(req);
  if (!found) {
    reply.code(404).send({ message: '分享链接无效或已过期' });
    return null;
  }
  return { babies: found.babies, canAccessAsset: (assetId) => assetBelongsTo(found.babies, assetId) };
}

export async function shareRoutes(app: FastifyInstance) {
  app.get('/api/share/:token', async (req, reply) => {
    const found = loadShare(req);
    if (!found) return reply.code(404).send({ message: '分享链接无效或已过期' });
    const prefix = `/api/share/${found.share.token}`;
    return {
      label: found.share.label,
      expiresAt: found.share.expiresAt,
      babies: found.babies.map((b) => ({ ...withAge(b), thumbnailUrl: `${prefix}/people/${b.immichPersonId}/thumbnail` })),
    };
  });

  app.get('/api/share/:token/people/:personId/thumbnail', async (req, reply) => {
    const found = loadShare(req);
    const { personId } = personParams.parse(req.params);
    if (!found?.babies.some((b) => b.immichPersonId === personId)) return reply.code(404).send({ message: '不存在' });
    return proxyMedia(req, reply, `/people/${personId}/thumbnail`, { cacheSeconds: 3600 });
  });

  registerAlbumRoutes(app, '/api/share/:token', resolve);
}
