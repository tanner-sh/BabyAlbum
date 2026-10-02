// 只读的相册接口。登录用户挂在 /api 下，分享链接访客挂在 /api/share/:token 下，
// 两者共用同一套路由，区别只在于上下文：能看哪些宝宝、能看哪些照片

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { computeAge, localToday } from '../age.ts';
import { assetHasPerson, dayItems, growthWall, liveVideoOf, monthItems, onThisDay, review, smartSearch, timeline } from '../album.ts';
import { secureCookie } from '../auth.ts';
import { dateOverrides, growthRecords, journal, milestones, social, type Baby } from '../db.ts';
import { notifyInteraction } from '../push.ts';
import { companions, familyPhotos, namedPeople } from '../family.ts';
import { placeZh } from '../geo.ts';
import { mapData, mapItems } from '../map.ts';
import { immich, proxyMedia } from '../immich.ts';

export type AlbumContext = {
  babies: Baby[];
  canAccessAsset: (assetId: string) => Promise<boolean>;
  /** 能否下载原图（分享链接可以关掉） */
  allowDownload: boolean;
  /** 搜索范围：true 表示能搜全部照片（包括没有宝宝的），否则只搜有这些宝宝的照片 */
  searchAll: boolean;
  /** 能否看家人（命名的人物）：登录用户可以，分享链接不行 */
  family: boolean;
  /** 点赞、留言：登录的家人，或者允许互动的分享链接的访客；null 表示不能互动 */
  interact: { kind: 'user'; userId: number; name: string; canModerate: boolean } | { kind: 'share'; shareId: number; defaultName: string } | null;
};

type Resolver = (req: FastifyRequest, reply: FastifyReply) => Promise<AlbumContext | null>;

const babyParams = z.object({ id: z.coerce.number().int() });
const monthParams = babyParams.extend({ m: z.coerce.number().int().min(0).max(240) });
const assetParams = z.object({ assetId: z.uuid() });
const timelineQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(500).default(120),
  // 只看和某个家人的合照，或者全家福
  with: z.union([z.uuid(), z.literal('family')]).optional(),
  // 从这一天之前开始往前看（时间线上“跳到某个月龄”）
  before: z.iso.date().optional(),
});
const sizeQuery = z.object({ size: z.enum(['thumbnail', 'preview']).default('thumbnail') });
const dayParams = babyParams.extend({ date: z.iso.date() });
const reviewQuery = z.object({ kind: z.enum(['month', 'year']), index: z.coerce.number().int().min(0).max(240) });
const searchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  // 只搜某个宝宝
  baby: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).max(50).default(1),
});

/** 拍摄地点：“黄浦，上海，中国”（地名翻成中文，同名的只写一次） */
function placeText(exif: { city?: string | null; state?: string | null; country?: string | null; latitude?: number | null; longitude?: number | null } | undefined) {
  if (!exif) return null;
  const { city, state, country } = placeZh(exif);
  return [...new Set([city, state, country].filter((x): x is string => !!x))].join('，') || null;
}

/** 成长数据附带测量时的年龄 */
export function measurementView(baby: Baby, r: ReturnType<typeof growthRecords.list>[number]) {
  const age = computeAge(baby.birthday, r.date);
  return { ...r, ageLabel: age.label, ageDays: age.days };
}

export function journalView(baby: Baby, e: ReturnType<typeof journal.list>[number]) {
  return { ...e, ageLabel: computeAge(baby.birthday, e.date).label };
}

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

// 简单的防刷：同一个人 10 分钟内最多留言 20 条
const recentComments = new Map<string, number[]>();
function tooManyComments(actor: string) {
  const now = Date.now();
  const list = (recentComments.get(actor) ?? []).filter((t) => now - t < 10 * 60_000);
  list.push(now);
  recentComments.set(actor, list);
  return list.length > 20;
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
    const { page, size, with: withWho, before } = timelineQuery.parse(req.query);
    if (!withWho) return timeline(baby, page, size, { before });
    const ctx = (await resolve(req, reply))!;
    if (!ctx.family) return reply.code(404).send({ message: '不存在' });
    if (withWho === 'family') return timeline(baby, page, size, { family: () => familyPhotos(baby), before });
    // 只能按已命名的家人筛选
    if (!(await namedPeople()).has(withWho)) return reply.code(404).send({ message: '不存在' });
    return timeline(baby, page, size, { withPerson: withWho, before });
  });

  // 和宝宝同框过的家人
  app.get(`${prefix}/babies/:id/companions`, async (req, reply) => {
    const baby = await babyFrom(req, reply);
    if (!baby) return reply;
    const ctx = (await resolve(req, reply))!;
    return ctx.family ? companions(baby) : [];
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

  app.get(`${prefix}/babies/:id/measurements`, async (req, reply) => {
    const baby = await babyFrom(req, reply);
    return baby ? growthRecords.list(baby.id).map((r) => measurementView(baby, r)) : reply;
  });

  app.get(`${prefix}/babies/:id/journal`, async (req, reply) => {
    const baby = await babyFrom(req, reply);
    return baby ? journal.list(baby.id).map((e) => journalView(baby, e)) : reply;
  });

  app.get(`${prefix}/babies/:id/days/:date`, async (req, reply) => {
    const baby = await babyFrom(req, reply);
    if (!baby) return reply;
    const { date } = dayParams.parse(req.params);
    return dayItems(baby, date);
  });

  app.get(`${prefix}/babies/:id/review`, async (req, reply) => {
    const baby = await babyFrom(req, reply);
    if (!baby) return reply;
    const { kind, index } = reviewQuery.parse(req.query);
    return review(baby, kind, index);
  });

  // 语义搜索：能看全部照片的用户搜全部，其他人（包括分享链接）只搜有自己能看的宝宝的照片
  app.get(`${prefix}/search`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const { q, baby: babyId, page } = searchQuery.parse(req.query);
    if (babyId !== undefined) {
      const baby = ctx.babies.find((b) => b.id === babyId);
      if (!baby) return reply.code(404).send({ message: '宝宝不存在' });
      return smartSearch(q, [baby.immichPersonId], page, 60);
    }
    if (!ctx.searchAll && !ctx.babies.length) return { page, nextPage: null, items: [] };
    return smartSearch(q, ctx.searchAll ? null : ctx.babies.map((b) => b.immichPersonId), page, 60);
  });

  // 地图：能看全部照片的用户默认看全部，其他人（包括分享链接）只看有自己能看的宝宝的照片
  app.get(`${prefix}/map`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const { baby: babyId } = z.object({ baby: z.coerce.number().int().optional() }).parse(req.query);
    if (babyId !== undefined) {
      const baby = ctx.babies.find((b) => b.id === babyId);
      if (!baby) return reply.code(404).send({ message: '宝宝不存在' });
      return mapData([baby]);
    }
    return mapData(ctx.searchAll ? null : ctx.babies);
  });

  // 地图上选中的照片：最多一次 300 张，逐个检查权限
  app.post(`${prefix}/map/items`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const { ids, baby: babyId } = z.object({ ids: z.array(z.uuid()).min(1).max(300), baby: z.number().int().optional() }).parse(req.body);
    const allowed = (await Promise.all(ids.map(async (id) => ((await ctx.canAccessAsset(id)) ? id : null)))).filter((id) => id !== null);
    const baby = babyId === undefined ? null : (ctx.babies.find((b) => b.id === babyId) ?? null);
    return mapItems(allowed, baby);
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
      place: placeText(a.exifInfo),
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

  // 是不是实况照片（还没配对好的，列表里不一定带着视频 ID，打开大图时再查一次）
  app.get(`${prefix}/assets/:assetId/live-id`, async (req, reply) => {
    const found = await assetFrom(req, reply);
    if (!found) return reply;
    return { videoId: await liveVideoOf(found.assetId) };
  });

  // ---- 点赞、留言
  /** 这次请求是谁：登录的家人用账号；分享链接的访客用浏览器里记住的访客 ID（没有就发一个） */
  function actorOf(req: FastifyRequest, reply: FastifyReply, ctx: AlbumContext, name?: string) {
    const it = ctx.interact;
    if (!it) return null;
    if (it.kind === 'user') return { id: `u:${it.userId}`, name: it.name, canModerate: it.canModerate };
    const cookieName = `visitor_${it.shareId}`;
    const raw = req.cookies[cookieName];
    let visitor = raw ? req.unsignCookie(raw) : null;
    if (!visitor?.valid || !visitor.value) {
      const value = randomBytes(12).toString('base64url');
      reply.setCookie(cookieName, value, { signed: true, httpOnly: true, sameSite: 'lax', secure: secureCookie(req), path: '/', maxAge: 365 * 24 * 3600 });
      visitor = { valid: true, renew: false, value };
    }
    return { id: `s:${it.shareId}:${visitor.value}`, name: name?.trim() || it.defaultName, canModerate: false };
  }

  const socialView = (assetId: string, me: string | null, canModerate: boolean) => ({
    likes: social.likes(assetId).map((l) => ({ name: l.name, mine: l.actor === me })),
    comments: social.comments(assetId).map((c) => ({ id: c.id, name: c.name, text: c.text, createdAt: c.createdAt, mine: c.actor === me, canDelete: c.actor === me || canModerate })),
  });

  app.get(`${prefix}/assets/:assetId/social`, async (req, reply) => {
    const found = await assetFrom(req, reply);
    if (!found) return reply;
    if (!found.ctx.interact) return reply.code(404).send({ message: '不存在' });
    // 只读接口不发访客 ID：没互动过的访客看不到“我的”
    const it = found.ctx.interact;
    const raw = it.kind === 'share' ? req.cookies[`visitor_${it.shareId}`] : null;
    const visitor = raw ? req.unsignCookie(raw) : null;
    const me = it.kind === 'user' ? `u:${it.userId}` : visitor?.valid ? `s:${it.shareId}:${visitor.value}` : null;
    return socialView(found.assetId, me, it.kind === 'user' && it.canModerate);
  });

  const nameBody = z.object({ name: z.string().trim().max(30).optional() });

  app.post(`${prefix}/assets/:assetId/like`, async (req, reply) => {
    const found = await assetFrom(req, reply);
    if (!found) return reply;
    const actor = actorOf(req, reply, found.ctx, nameBody.parse(req.body ?? {}).name);
    if (!actor) return reply.code(403).send({ message: '这个分享没有打开点赞留言' });
    const liked = social.toggleLike(found.assetId, actor.id, actor.name);
    if (liked) notifyInteraction({ assetId: found.assetId, actor: actor.id, text: `${actor.name}赞了一张照片` });
    return socialView(found.assetId, actor.id, actor.canModerate);
  });

  app.post(`${prefix}/assets/:assetId/comments`, async (req, reply) => {
    const found = await assetFrom(req, reply);
    if (!found) return reply;
    const body = nameBody.extend({ text: z.string().trim().min(1, '写点什么吧').max(500) }).parse(req.body);
    const actor = actorOf(req, reply, found.ctx, body.name);
    if (!actor) return reply.code(403).send({ message: '这个分享没有打开点赞留言' });
    if (tooManyComments(actor.id)) return reply.code(429).send({ message: '留言太频繁了，歇一会儿再来' });
    social.addComment({ assetId: found.assetId, actor: actor.id, name: actor.name, text: body.text });
    notifyInteraction({ assetId: found.assetId, actor: actor.id, text: `${actor.name}：${body.text}` });
    return socialView(found.assetId, actor.id, actor.canModerate);
  });

  // 删除留言：自己的，或者管理员、家人删别人的
  app.delete(`${prefix}/comments/:commentId`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const { commentId } = z.object({ commentId: z.coerce.number().int() }).parse(req.params);
    const comment = social.comment(commentId);
    const actor = actorOf(req, reply, ctx);
    if (!comment || !actor || !(await ctx.canAccessAsset(comment.assetId))) return reply.code(404).send({ message: '留言不存在' });
    if (comment.actor !== actor.id && !actor.canModerate) return reply.code(403).send({ message: '只能删除自己的留言' });
    social.removeComment(commentId);
    return reply.code(204).send();
  });

  // 实况照片的视频部分：按照片检查权限（视频本身可能没有识别出人脸）
  app.get(`${prefix}/assets/:assetId/live`, async (req, reply) => {
    const found = await assetFrom(req, reply);
    if (!found) return reply;
    const videoId = await liveVideoOf(found.assetId);
    if (!videoId) return reply.code(404).send({ message: '不是实况照片' });
    return proxyMedia(req, reply, `/assets/${videoId}/video/playback`, { cacheSeconds: 7 * 24 * 3600 });
  });

  app.get(`${prefix}/assets/:assetId/original`, async (req, reply) => {
    const found = await assetFrom(req, reply);
    if (!found) return reply;
    if (!found.ctx.allowDownload) return reply.code(403).send({ message: '这个分享不允许下载原图' });
    return proxyMedia(req, reply, `/assets/${found.assetId}/original`, { download: true });
  });
}
