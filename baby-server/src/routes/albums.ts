// 手动相册：自己挑照片建的相册（满月酒、第一次旅行），可以单独分享。
// 登录的家人都能看；家人（member）和管理员可以建、改；受限成员只能看到相册里自己有权限的照片，只能改、删自己建的相册

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cachedPhotos, mapLimit, tidyAssets, toPhotoItem } from '../album.ts';
import { editors } from '../auth.ts';
import { albums, dateOverrides } from '../db.ts';
import { immich } from '../immich.ts';
import { accessibleAssetIds, canAccessAsset, canManageAlbum, unrestricted } from './manage.ts';

const idParams = z.object({ id: z.coerce.number().int() });
const albumBody = z.object({
  title: z.string().trim().min(1, '请填写相册名字').max(50),
  description: z.string().trim().max(500).default(''),
});
const assetsBody = z.object({ assetIds: z.array(z.uuid()).min(1).max(1000) });

/** 相册里的照片，按拍摄时间正序（看相册像翻一本书）。canAccess 用来过滤没有权限的照片 */
export async function albumItems(albumId: number, canAccess: (assetId: string) => Promise<boolean>) {
  const ids = albums.assetIds(albumId);
  const ok = await mapLimit(ids, 8, canAccess);
  const allowed = ids.filter((_, i) => ok[i]);
  const assets = (await mapLimit(allowed, 8, (id) => cachedPhotos(`asset:${id}`, 10 * 60_000, () => immich.getAssetInfo({ id })).catch(() => null))).filter(
    (a): a is immich.AssetResponseDto => !!a,
  );
  const overrides = dateOverrides.all();
  const items = (await tidyAssets(assets)).map((a) => (overrides.has(a.id) ? { ...a, localDateTime: `${overrides.get(a.id)}.000Z` } : a));
  return items.sort((a, b) => a.localDateTime.localeCompare(b.localDateTime)).map(toPhotoItem);
}

const view = (a: NonNullable<ReturnType<typeof albums.get>>) => ({ ...a, coverAssetId: a.coverAssetId ?? albums.assetIds(a.id)[0] ?? null });

/** 要修改的相册：不存在、或者不是自己能改的（受限成员只能改自己建的）都当作不存在 */
function albumToManage(req: FastifyRequest, reply: FastifyReply, id: number) {
  const album = albums.get(id);
  if (!album) {
    reply.code(404).send({ message: '相册不存在' });
    return null;
  }
  if (!canManageAlbum(req.user!, album)) {
    reply.code(403).send({ message: '只能修改自己建的相册' });
    return null;
  }
  return album;
}

export async function albumRoutes(app: FastifyInstance) {
  app.get('/api/albums', async (req) => {
    const list = albums.list().map(view);
    if (unrestricted(req.user!)) return list;
    // 受限成员：只算自己能看的照片，一张都看不到的别人的相册不显示（和打开相册时的规则一样）
    const result = await mapLimit(list, 2, async (a) => {
        const ids = await accessibleAssetIds(req.user!, albums.assetIds(a.id));
        if (!ids.length && !canManageAlbum(req.user!, a)) return null;
        const cover = a.coverAssetId && ids.includes(a.coverAssetId) ? a.coverAssetId : (ids[0] ?? null);
        return { ...a, count: ids.length, coverAssetId: cover };
    });
    return result.filter((a) => a !== null);
  });

  app.post('/api/albums', { preHandler: editors }, async (req, reply) => {
    const body = albumBody.parse(req.body);
    return reply.code(201).send(view(albums.create({ ...body, createdBy: req.user!.id })));
  });

  app.get('/api/albums/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const album = albums.get(id);
    if (!album) return reply.code(404).send({ message: '相册不存在' });
    // 和列表一致：受限成员一张都看不到的别人的相册，当作不存在
    if (!canManageAlbum(req.user!, album) && !(await accessibleAssetIds(req.user!, albums.assetIds(id))).length) return reply.code(404).send({ message: '相册不存在' });
    return { album: view(album), items: await albumItems(id, (assetId) => canAccessAsset(req.user!, assetId)) };
  });

  app.put('/api/albums/:id', { preHandler: editors }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const current = albumToManage(req, reply, id);
    if (!current) return reply;
    const body = albumBody.extend({ coverAssetId: z.uuid().nullable().optional() }).parse(req.body);
    const cover = body.coverAssetId === undefined ? current.coverAssetId : body.coverAssetId;
    if (cover && !albums.has(id, cover)) return reply.code(400).send({ message: '封面要从相册里的照片中选' });
    return view(albums.update(id, { title: body.title, description: body.description, coverAssetId: cover })!);
  });

  app.delete('/api/albums/:id', { preHandler: editors }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    if (!albumToManage(req, reply, id)) return reply;
    albums.remove(id);
    return reply.code(204).send();
  });

  // 加照片：只能加自己能看的照片
  app.post('/api/albums/:id/assets', { preHandler: editors }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    if (!albumToManage(req, reply, id)) return reply;
    const { assetIds } = assetsBody.parse(req.body);
    for (const assetId of assetIds) if (!(await canAccessAsset(req.user!, assetId))) return reply.code(404).send({ message: '照片不存在' });
    return { added: albums.add(id, assetIds), album: view(albums.get(id)!) };
  });

  // 移出照片：只是不在这个相册里了，照片本身不受影响
  app.post('/api/albums/:id/assets/remove', { preHandler: editors }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    if (!albumToManage(req, reply, id)) return reply;
    const { assetIds } = assetsBody.parse(req.body);
    albums.removeAssets(id, assetIds);
    return view(albums.get(id)!);
  });
}
