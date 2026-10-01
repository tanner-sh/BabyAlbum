// 只读的相册接口。登录用户挂在 /api 下，分享链接访客挂在 /api/share/:token 下，
// 两者共用同一套路由，区别只在于上下文：能看哪些宝宝、能看哪些照片

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { computeAge, localToday } from '../age.ts';
import { assetHasPerson, growthWall, monthItems, onThisDay, timeline } from '../album.ts';
import { dateOverrides, milestones, type Baby } from '../db.ts';
import { immich, proxyMedia } from '../immich.ts';

export type AlbumContext = {
  babies: Baby[];
  canAccessAsset: (assetId: string) => Promise<boolean>;
};

type Resolver = (req: FastifyRequest, reply: FastifyReply) => Promise<AlbumContext | null>;

const babyParams = z.object({ id: z.coerce.number().int() });
const monthParams = babyParams.extend({ m: z.coerce.number().int().min(0).max(240) });
const assetParams = z.object({ assetId: z.uuid() });
const timelineQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(500).default(120),
});
const sizeQuery = z.object({ size: z.enum(['thumbnail', 'preview']).default('thumbnail') });

export function withAge(baby: Baby) {
  const age = computeAge(baby.birthday, localToday());
  return { ...baby, ageLabel: age.label, thumbnailUrl: `/api/people/${baby.immichPersonId}/thumbnail` };
}

export function milestoneView(baby: Baby, m: ReturnType<typeof milestones.list>[number]) {
  return { ...m, ageLabel: computeAge(baby.birthday, m.date).label };
}

/** 照片里是否有这些宝宝之一，或者是这些宝宝某个里程碑的封面 */
export async function assetBelongsTo(babies: Baby[], assetId: string) {
  const isCover = babies.some((b) => milestones.list(b.id).some((m) => m.coverAssetId === assetId));
  return isCover || assetHasPerson(assetId, babies.map((b) => b.immichPersonId));
}

export function registerAlbumRoutes(app: FastifyInstance, prefix: string, resolve: Resolver) {
  async function babyFrom(req: FastifyRequest, reply: FastifyReply) {
    const ctx = await resolve(req, reply);
    if (!ctx) return null;
    const { id } = babyParams.parse(req.params);
    const baby = ctx.babies.find((b) => b.id === id);
    if (!baby) {
      reply.code(404).send({ message: '宝宝不存在' });
      return null;
    }
    return baby;
  }

  async function assetFrom(req: FastifyRequest, reply: FastifyReply) {
    const ctx = await resolve(req, reply);
    if (!ctx) return null;
    const { assetId } = assetParams.parse(req.params);
    if (!(await ctx.canAccessAsset(assetId))) {
      reply.code(404).send({ message: '照片不存在' });
      return null;
    }
    return { ctx, assetId };
  }

  app.get(`${prefix}/babies/:id/timeline`, async (req, reply) => {
    const baby = await babyFrom(req, reply);
    if (!baby) return reply;
    const { page, size } = timelineQuery.parse(req.query);
    return timeline(baby, page, size);
  });

  app.get(`${prefix}/babies/:id/on-this-day`, async (req, reply) => {
    const baby = await babyFrom(req, reply);
    return baby ? onThisDay(baby) : reply;
  });

  app.get(`${prefix}/babies/:id/growth`, async (req, reply) => {
    const baby = await babyFrom(req, reply);
    return baby ? growthWall(baby) : reply;
  });

  app.get(`${prefix}/babies/:id/months/:m`, async (req, reply) => {
    const baby = await babyFrom(req, reply);
    if (!baby) return reply;
    const { m } = monthParams.parse(req.params);
    return monthItems(baby, m);
  });

  app.get(`${prefix}/babies/:id/milestones`, async (req, reply) => {
    const baby = await babyFrom(req, reply);
    return baby ? milestones.list(baby.id).map((m) => milestoneView(baby, m)) : reply;
  });

  app.get(`${prefix}/assets/:assetId`, async (req, reply) => {
    const found = await assetFrom(req, reply);
    if (!found) return reply;
    const a = await immich.getAssetInfo({ id: found.assetId });
    const personIds = new Set((a.people ?? []).map((p) => p.id));
    const fixed = dateOverrides.all().get(a.id);
    const takenAt = fixed ? `${fixed}.000Z` : a.localDateTime;
    return {
      id: a.id,
      type: a.type,
      takenAt,
      // 日期被更正过时，附上原始日期，方便恢复
      originalTakenAt: fixed ? a.localDateTime : null,
      fileName: a.originalFileName,
      isFavorite: a.isFavorite,
      duration: a.duration,
      width: a.width,
      height: a.height,
      fileSize: a.exifInfo?.fileSizeInByte ?? null,
      camera: [a.exifInfo?.make, a.exifInfo?.model].filter(Boolean).join(' ') || null,
      place: [a.exifInfo?.city, a.exifInfo?.country].filter(Boolean).join('，') || null,
      // 只列出当前上下文里的宝宝，分享链接不暴露其他人物
      babies: found.ctx.babies
        .filter((b) => personIds.has(b.immichPersonId))
        .map((b) => ({ id: b.id, name: b.name, ageLabel: computeAge(b.birthday, takenAt).label })),
    };
  });

  app.get(`${prefix}/assets/:assetId/thumbnail`, async (req, reply) => {
    const found = await assetFrom(req, reply);
    if (!found) return reply;
    const { size } = sizeQuery.parse(req.query);
    // 缩略图内容由 asset ID 唯一确定，可以长时间缓存
    return proxyMedia(req, reply, `/assets/${found.assetId}/thumbnail?size=${size}`, { cacheSeconds: 7 * 24 * 3600 });
  });

  app.get(`${prefix}/assets/:assetId/video`, async (req, reply) => {
    const found = await assetFrom(req, reply);
    if (!found) return reply;
    return proxyMedia(req, reply, `/assets/${found.assetId}/video/playback`, { cacheSeconds: 24 * 3600 });
  });

  app.get(`${prefix}/assets/:assetId/original`, async (req, reply) => {
    const found = await assetFrom(req, reply);
    if (!found) return reply;
    return proxyMedia(req, reply, `/assets/${found.assetId}/original`, { download: true });
  });
}
