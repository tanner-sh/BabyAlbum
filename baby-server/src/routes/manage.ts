// 登录用户的接口：宝宝档案、里程碑、收藏、日期更正、分享链接、相册浏览
//
// 权限：
//   管理员 admin   全部
//   家人   member  浏览、收藏、里程碑、日期更正、分享（只限自己能看的宝宝）
//   只读   viewer  浏览
// 设置了“只能看某几个宝宝”的用户，只能看到有这些宝宝出现的照片

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clearAlbumCache, dateIssues } from '../album.ts';
import { adminOnly, canSeeBaby, editors, newToken } from '../auth.ts';
import { babies, dateOverrides, milestones, shares, type Baby, type User } from '../db.ts';
import { immich, proxyMedia } from '../immich.ts';
import { assetBelongsTo, milestoneView, registerAlbumRoutes, withAge } from './album.ts';

const idParams = z.object({ id: z.coerce.number().int() });
const uuidParams = z.object({ id: z.uuid() });

const babyBody = z.object({
  name: z.string().trim().min(1).max(50),
  immichPersonId: z.uuid(),
  // 不填时使用人物上设置的生日
  birthday: z.iso.date().optional(),
});
const babyPatch = z.object({ name: z.string().trim().min(1).max(50).optional(), birthday: z.iso.date().optional() });

const milestoneBody = z.object({
  title: z.string().trim().min(1).max(100),
  date: z.iso.date(),
  note: z.string().max(2000).default(''),
  coverAssetId: z.uuid().nullable().default(null),
});

const shareBody = z.object({
  label: z.string().trim().min(1).max(50),
  babyIds: z.array(z.number().int()).min(1),
  // 不填表示永久有效
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

// ---------------------------------------------------------------- 按用户过滤

export const visibleBabies = (user: User) => babies.list().filter((b) => canSeeBaby(user, b.id));
const unrestricted = (user: User) => user.role === 'admin' || user.babyIds === null;

/** 受限用户只能访问有自己能看的宝宝出现的照片 */
export function canAccessAsset(user: User, assetId: string) {
  return unrestricted(user) ? Promise.resolve(true) : assetBelongsTo(visibleBabies(user), assetId);
}

/** 取一个当前用户能看的宝宝，看不到就当作不存在 */
function babyFor(req: FastifyRequest, reply: FastifyReply, id: number): Baby | null {
  const baby = babies.get(id);
  if (!baby || !canSeeBaby(req.user!, id)) {
    reply.code(404).send({ message: '宝宝不存在' });
    return null;
  }
  return baby;
}

async function assetFor(req: FastifyRequest, reply: FastifyReply, assetId: string) {
  if (await canAccessAsset(req.user!, assetId)) return true;
  reply.code(404).send({ message: '照片不存在' });
  return false;
}

export async function manageRoutes(app: FastifyInstance) {
  // ---------- 人物头像（宝宝头像也用它）：管理员能看所有人物，其他人只能看自己能看的宝宝
  app.get('/api/people/:id/thumbnail', async (req, reply) => {
    const { id } = uuidParams.parse(req.params);
    const allowed = req.user!.role === 'admin' || visibleBabies(req.user!).some((b) => b.immichPersonId === id);
    if (!allowed) return reply.code(404).send({ message: '不存在' });
    return proxyMedia(req, reply, `/people/${id}/thumbnail`, { cacheSeconds: 3600 });
  });

  // ---------- 宝宝（增删改只有管理员）
  app.get('/api/babies', async (req) => visibleBabies(req.user!).map(withAge));

  app.post('/api/babies', { preHandler: adminOnly }, async (req, reply) => {
    const body = babyBody.parse(req.body);
    const person = await immich.getPerson({ id: body.immichPersonId });
    const birthday = body.birthday ?? person.birthDate;
    if (!birthday) return reply.code(400).send({ message: '请填写生日' });
    try {
      return reply.code(201).send(withAge(babies.create({ name: body.name, birthday, immichPersonId: person.id })));
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE')) return reply.code(409).send({ message: '这个人物已经关联了宝宝' });
      throw err;
    }
  });

  app.patch('/api/babies/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const current = babies.get(id);
    if (!current) return reply.code(404).send({ message: '宝宝不存在' });
    const updated = babies.update(id, { ...current, ...babyPatch.parse(req.body) })!;
    clearAlbumCache();
    return withAge(updated);
  });

  app.delete('/api/babies/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return babies.remove(id) ? reply.code(204).send() : reply.code(404).send({ message: '宝宝不存在' });
  });

  // ---------- 里程碑（读取接口在 album.ts 中）
  app.post('/api/babies/:id/milestones', { preHandler: editors }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const baby = babyFor(req, reply, id);
    if (!baby) return reply;
    const m = milestones.create({ babyId: id, ...milestoneBody.parse(req.body) });
    return reply.code(201).send(milestoneView(baby, m));
  });

  app.put('/api/milestones/:id', { preHandler: editors }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const current = milestones.get(id);
    if (!current || !babyFor(req, reply, current.babyId)) return reply.sent ? reply : reply.code(404).send({ message: '里程碑不存在' });
    const m = milestones.update(id, milestoneBody.parse(req.body))!;
    return milestoneView(babies.get(m.babyId)!, m);
  });

  app.delete('/api/milestones/:id', { preHandler: editors }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const current = milestones.get(id);
    if (!current || !babyFor(req, reply, current.babyId)) return reply.sent ? reply : reply.code(404).send({ message: '里程碑不存在' });
    milestones.remove(id);
    return reply.code(204).send();
  });

  // ---------- 收藏（直接写回 Immich）
  app.put('/api/assets/:id/favorite', { preHandler: editors }, async (req, reply) => {
    const { id } = uuidParams.parse(req.params);
    if (!(await assetFor(req, reply, id))) return reply;
    const { isFavorite } = z.object({ isFavorite: z.boolean() }).parse(req.body);
    const asset = await immich.updateAsset({ id, updateAssetDto: { isFavorite } });
    clearAlbumCache();
    return { id: asset.id, isFavorite: asset.isFavorite };
  });

  // ---------- 拍摄日期更正（只在宝宝相册里生效，不改原文件和 Immich）
  app.get('/api/babies/:id/date-issues', { preHandler: editors }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const baby = babyFor(req, reply, id);
    return baby ? dateIssues(baby) : reply;
  });

  app.post('/api/date-overrides', { preHandler: editors }, async (req, reply) => {
    const body = z
      .object({
        assetIds: z.array(z.uuid()).min(1).max(1000),
        // 2024-05-21 或 2024-05-21T10:30
        takenAt: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/),
      })
      .parse(req.body);
    const [date, time = '12:00'] = body.takenAt.split('T');
    if (Number.isNaN(Date.parse(date))) return reply.code(400).send({ message: '日期无效' });
    for (const id of body.assetIds) if (!(await canAccessAsset(req.user!, id))) return reply.code(404).send({ message: '照片不存在' });
    dateOverrides.set(body.assetIds, `${date}T${time.length === 5 ? `${time}:00` : time}`);
    clearAlbumCache();
    return { updated: body.assetIds.length };
  });

  app.delete('/api/date-overrides/:id', { preHandler: editors }, async (req, reply) => {
    const { id } = uuidParams.parse(req.params);
    if (!(await assetFor(req, reply, id))) return reply;
    if (!dateOverrides.remove(id)) return reply.code(404).send({ message: '这张照片没有更正过日期' });
    clearAlbumCache();
    return reply.code(204).send();
  });

  // ---------- 家人分享链接（家人只能分享、管理自己能看的宝宝）
  const shareVisible = (user: User, babyIds: number[]) => babyIds.every((id) => canSeeBaby(user, id));

  app.get('/api/shares', { preHandler: editors }, async (req) => shares.list().filter((s) => shareVisible(req.user!, s.babyIds)));

  app.post('/api/shares', { preHandler: editors }, async (req, reply) => {
    const body = shareBody.parse(req.body);
    const allowed = new Set(visibleBabies(req.user!).map((b) => b.id));
    if (!body.babyIds.every((id) => allowed.has(id))) return reply.code(400).send({ message: '宝宝不存在' });
    const share = shares.create({
      token: newToken(),
      label: body.label,
      babyIds: body.babyIds,
      expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString() : null,
    });
    return reply.code(201).send(share);
  });

  app.delete('/api/shares/:id', { preHandler: editors }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const share = shares.list().find((s) => s.id === id);
    if (!share || !shareVisible(req.user!, share.babyIds)) return reply.code(404).send({ message: '分享不存在' });
    shares.remove(id);
    return reply.code(204).send();
  });

  // ---------- 相册浏览
  registerAlbumRoutes(app, '/api', async (req) => ({
    babies: visibleBabies(req.user!),
    canAccessAsset: (assetId) => canAccessAsset(req.user!, assetId),
  }));
}
