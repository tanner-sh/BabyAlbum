// 管理员接口：成员管理、照片库（Immich）、人物、系统设置。
// Immich 只在后台工作，管理员不需要打开 Immich 的界面，也不需要改 Docker 配置

import { readdir } from 'node:fs/promises';
import { posix } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { clearAlbumCache } from '../album.ts';
import { adminOnly, displayNameSchema, newToken, passwordSchema, publicUser, usernameSchema } from '../auth.ts';
import { config } from '../config.ts';
import { babies, invites, nasSources, settings, transaction, users, type NasSource, type Role } from '../db.ts';
import { getBackupTarget, isMounterAvailable, mountSource, MounterError, mountState, nasMountPath, nasTarget, setBackupTarget, testConnection, unmountSource } from '../nas.ts';
import { connectWithCredentials, immichConnected, immichStatus } from '../immich-link.ts';
import { immich } from '../immich.ts';
import { hashPassword } from '../password.ts';

const roleSchema = z.enum(['admin', 'member', 'viewer']);
const babyIdsSchema = z.array(z.number().int()).nullable();
const idParams = z.object({ id: z.coerce.number().int() });
const uuidParams = z.object({ id: z.uuid() });

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

// ---------------------------------------------------------------- 任务队列的中文名称

const QUEUE_LABELS: Partial<Record<immich.QueueName, string>> = {
  library: '扫描文件夹',
  metadataExtraction: '读取拍摄信息',
  thumbnailGeneration: '生成缩略图',
  faceDetection: '检测人脸',
  facialRecognition: '识别人物',
  smartSearch: '语义搜索索引',
  duplicateDetection: '查找重复照片',
  videoConversion: '视频转码',
  ocr: '文字识别',
  sidecar: '读取附属文件',
  backupDatabase: '备份数据库',
  backgroundTask: '后台任务',
};

// ---------------------------------------------------------------- 系统设置：只开放常用的几项，用中文说明

const concurrencyKeys = ['library', 'metadataExtraction', 'thumbnailGeneration', 'faceDetection', 'smartSearch', 'videoConversion'] as const;

const settingsSchema = z.object({
  transcode: z.enum(['disabled', 'required', 'optimal', 'all']),
  targetResolution: z.enum(['480', '720', '1080', '1440', '2160', 'original']),
  machineLearning: z.boolean(),
  facialRecognition: z.boolean(),
  smartSearch: z.boolean(),
  duplicateDetection: z.boolean(),
  ocr: z.boolean(),
  minFaces: z.number().int().min(1).max(50),
  concurrency: z.object(Object.fromEntries(concurrencyKeys.map((k) => [k, z.number().int().min(1).max(32)])) as Record<
    (typeof concurrencyKeys)[number],
    z.ZodNumber
  >),
  libraryScan: z.object({ enabled: z.boolean(), cronExpression: z.string().min(9).max(100) }),
  backup: z.object({ enabled: z.boolean(), cronExpression: z.string().min(9).max(100), keepLastAmount: z.number().int().min(1).max(365) }),
  reverseGeocoding: z.boolean(),
  trashDays: z.number().int().min(1).max(365),
});
type CuratedSettings = z.infer<typeof settingsSchema>;

function toCurated(c: immich.AdminConfigDto): CuratedSettings {
  return {
    transcode: c.ffmpeg.transcode as CuratedSettings['transcode'],
    targetResolution: c.ffmpeg.targetResolution as CuratedSettings['targetResolution'],
    machineLearning: c.machineLearning.enabled,
    facialRecognition: c.machineLearning.facialRecognition.enabled,
    smartSearch: c.machineLearning.clip.enabled,
    duplicateDetection: c.machineLearning.duplicateDetection.enabled,
    ocr: c.machineLearning.ocr.enabled,
    minFaces: c.machineLearning.facialRecognition.minFaces,
    concurrency: Object.fromEntries(concurrencyKeys.map((k) => [k, c.job[k].concurrency])) as CuratedSettings['concurrency'],
    libraryScan: { enabled: c.library.scan.enabled, cronExpression: c.library.scan.cronExpression },
    backup: { ...c.backup.database },
    reverseGeocoding: c.reverseGeocoding.enabled,
    trashDays: c.trash.days,
  };
}

function applyCurated(c: immich.AdminConfigDto, s: Partial<CuratedSettings>): immich.AdminConfigDto {
  if (s.transcode) c.ffmpeg.transcode = s.transcode as immich.TranscodePolicy;
  if (s.targetResolution) c.ffmpeg.targetResolution = s.targetResolution;
  if (s.machineLearning !== undefined) c.machineLearning.enabled = s.machineLearning;
  if (s.facialRecognition !== undefined) c.machineLearning.facialRecognition.enabled = s.facialRecognition;
  if (s.smartSearch !== undefined) c.machineLearning.clip.enabled = s.smartSearch;
  if (s.duplicateDetection !== undefined) c.machineLearning.duplicateDetection.enabled = s.duplicateDetection;
  if (s.ocr !== undefined) c.machineLearning.ocr.enabled = s.ocr;
  if (s.minFaces !== undefined) c.machineLearning.facialRecognition.minFaces = s.minFaces;
  if (s.concurrency) for (const k of concurrencyKeys) if (s.concurrency[k]) c.job[k].concurrency = s.concurrency[k];
  if (s.libraryScan) c.library.scan = { ...c.library.scan, ...s.libraryScan };
  if (s.backup) c.backup.database = { ...c.backup.database, ...s.backup };
  if (s.reverseGeocoding !== undefined) c.reverseGeocoding.enabled = s.reverseGeocoding;
  if (s.trashDays !== undefined) c.trash.days = s.trashDays;
  return c;
}

// ---------------------------------------------------------------- NAS 文件夹

const HIDDEN_DIR = /^[.@#]|^lost\+found$/;

/** 把相对路径解析到 NAS 挂载点下，防止 ../ 跳出去 */
function nasPath(rel: string) {
  const full = posix.normalize(posix.join(config.NAS_ROOT, rel));
  if (full !== config.NAS_ROOT && !full.startsWith(`${config.NAS_ROOT}/`)) throw Object.assign(new Error('路径无效'), { statusCode: 400 });
  return full;
}

const importPathSchema = z
  .string()
  .min(1)
  .transform((p, ctx) => {
    const full = posix.normalize(p);
    if (full !== config.NAS_ROOT && !full.startsWith(`${config.NAS_ROOT}/`)) {
      ctx.addIssue({ code: 'custom', message: `只能导入 ${config.NAS_ROOT} 下的文件夹` });
      return z.NEVER;
    }
    return full.replace(/\/$/, '');
  });

const DEFAULT_EXCLUSIONS = ['**/@eaDir/**', '**/#recycle/**', '**/.*/**', '**/@Recycle/**'];

// ---------------------------------------------------------------- 路由

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminOnly);

  // ======== 成员

  app.get('/api/admin/users', async () => users.list().map((u) => ({ ...publicUser(u), disabled: u.disabled, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt })));

  app.post('/api/admin/users', async (req, reply) => {
    const body = z
      .object({ username: usernameSchema, displayName: displayNameSchema, password: passwordSchema, role: roleSchema, babyIds: babyIdsSchema.default(null) })
      .parse(req.body);
    if (users.byUsername(body.username)) return reply.code(409).send({ message: '这个用户名已经被用了' });
    const user = users.create({ ...body, passwordHash: await hashPassword(body.password) });
    return reply.code(201).send(publicUser(user));
  });

  app.patch('/api/admin/users/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = z
      .object({ displayName: displayNameSchema.optional(), role: roleSchema.optional(), babyIds: babyIdsSchema.optional(), disabled: z.boolean().optional() })
      .parse(req.body);
    const result = transaction(() => {
      const current = users.get(id);
      if (!current) return { status: 404, message: '成员不存在' };
      const next = { displayName: current.displayName, role: current.role, babyIds: current.babyIds, disabled: current.disabled, ...body };
      // 至少保留一个可用的管理员
      const losesAdmin = current.role === 'admin' && !current.disabled && (next.role !== 'admin' || next.disabled);
      if (losesAdmin && users.activeAdmins() <= 1) return { status: 400, message: '至少要保留一个管理员' };
      if (id === req.user!.id && next.disabled) return { status: 400, message: '不能停用自己' };
      return { user: users.update(id, next)! };
    });
    if ('message' in result) return reply.code(result.status!).send({ message: result.message });
    return publicUser(result.user);
  });

  app.put('/api/admin/users/:id/password', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { password } = z.object({ password: passwordSchema }).parse(req.body);
    return users.setPassword(id, await hashPassword(password)) ? reply.code(204).send() : reply.code(404).send({ message: '成员不存在' });
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    if (id === req.user!.id) return reply.code(400).send({ message: '不能删除自己' });
    const result = transaction(() => {
      const u = users.get(id);
      if (!u) return 404;
      if (u.role === 'admin' && !u.disabled && users.activeAdmins() <= 1) return 400;
      users.remove(id);
      return 204;
    });
    if (result === 404) return reply.code(404).send({ message: '成员不存在' });
    if (result === 400) return reply.code(400).send({ message: '至少要保留一个管理员' });
    return reply.code(204).send();
  });

  // ======== 邀请链接

  app.get('/api/admin/invites', async () => {
    const now = new Date().toISOString();
    return invites.list().map((i) => ({ ...i, usedByName: i.usedBy ? (users.get(i.usedBy)?.displayName ?? null) : null, expired: i.expiresAt < now }));
  });

  app.post('/api/admin/invites', async (req, reply) => {
    const body = z
      .object({ role: roleSchema, babyIds: babyIdsSchema.default(null), note: z.string().trim().max(50).default(''), expiresInDays: z.number().int().min(1).max(30).default(7) })
      .parse(req.body);
    const invite = invites.create({
      token: newToken(),
      role: body.role as Role,
      babyIds: body.babyIds,
      note: body.note,
      expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString(),
    });
    return reply.code(201).send(invite);
  });

  app.delete('/api/admin/invites/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string() }).parse(req.params);
    return invites.remove(token) ? reply.code(204).send() : reply.code(404).send({ message: '邀请不存在' });
  });

  // ======== 照片库（Immich）

  app.get('/api/admin/immich', async () => {
    const status = immichStatus();
    if (!immichConnected()) return { status, nasRoot: config.NAS_ROOT };
    const [version, stats, storage, queues, libraries] = await Promise.all([
      immich.getServerVersion(),
      immich.getServerStatistics(),
      immich.getStorage(),
      immich.getQueues(),
      immich.getAllLibraries(),
    ]);
    // 外部图库的文件数、大小要单独查（Immich 的总统计只算上传到它自己的文件）
    const libraryStats = await Promise.all(libraries.map((l) => immich.getLibraryStatistics({ id: l.id })));
    return {
      status,
      nasRoot: config.NAS_ROOT,
      version: `v${version.major}.${version.minor}.${version.patch}`,
      serviceAccount: settings.get('immich.serviceEmail') ?? null,
      stats: { photos: stats.photos, videos: stats.videos, usage: libraryStats.reduce((n, l) => n + l.usage, stats.usage) },
      storage: { used: storage.diskUse, size: storage.diskSize, available: storage.diskAvailable, percent: storage.diskUsagePercentage },
      queues: queues
        .filter((q) => QUEUE_LABELS[q.name])
        .map((q) => ({ name: q.name, label: QUEUE_LABELS[q.name], isPaused: q.isPaused, ...q.statistics })),
      libraries: libraries.map((l, i) => ({
        id: l.id,
        name: l.name,
        importPaths: l.importPaths,
        exclusionPatterns: l.exclusionPatterns,
        assetCount: libraryStats[i].total,
        usage: libraryStats[i].usage,
        refreshedAt: l.refreshedAt,
      })),
    };
  });

  // 接入一个已经初始化过的 Immich：管理员输入一次 Immich 管理员账号密码
  app.post('/api/admin/immich/connect', async (req, reply) => {
    const { email, password } = z.object({ email: z.string().min(3), password: z.string().min(1) }).parse(req.body);
    try {
      await connectWithCredentials(email, password, req.log);
    } catch (err) {
      const message = immich.isHttpError(err) && err.status === 401 ? 'Immich 账号或密码错误' : err instanceof Error ? err.message : '连接失败';
      return reply.code(400).send({ message });
    }
    return { status: immichStatus() };
  });

  app.post('/api/admin/immich/queues/:name', async (req) => {
    const { name } = z.object({ name: z.enum(Object.keys(QUEUE_LABELS) as [string, ...string[]]) }).parse(req.params);
    const { command } = z.object({ command: z.enum(['start', 'pause', 'resume', 'clear-failed']) }).parse(req.body);
    // start：只处理还没处理过的（force=false），不会把已完成的重新跑一遍
    await immich.runQueueCommandLegacy({ name: name as immich.QueueName, queueCommandDto: { command: command as immich.QueueCommand, force: false } });
    return { ok: true };
  });

  // ---- 系统设置
  app.get('/api/admin/immich/settings', async () => toCurated(await immich.getConfig()));

  app.put('/api/admin/immich/settings', async (req) => {
    const patch = settingsSchema.partial().parse(req.body);
    const updated = await immich.updateConfig({ adminConfigDto: applyCurated(await immich.getConfig(), patch) });
    return toCurated(updated);
  });

  // ---- NAS 文件夹浏览（选择导入哪些文件夹）
  app.get('/api/admin/folders', async (req, reply) => {
    const { path: rel } = z.object({ path: z.string().default('') }).parse(req.query);
    const full = nasPath(rel);
    // NAS 断开时读目录可能卡住，加超时
    const entries = await Promise.race([
      readdir(full, { withFileTypes: true }).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
    ]);
    if (!entries) return reply.code(404).send({ message: rel ? '读取不了这个文件夹（NAS 可能断开了）' : '还没有添加 NAS' });
    // 根目录下的 1、2…… 是各个 NAS 连接，显示成它们的名字
    const names = new Map(nasSources.list().map((n) => [String(n.id), n.name]));
    return {
      path: full,
      relative: posix.relative(config.NAS_ROOT, full),
      folders: entries
        .filter((e) => e.isDirectory() && !HIDDEN_DIR.test(e.name))
        .map((e) => ({ name: e.name, label: rel ? e.name : (names.get(e.name) ?? e.name), path: posix.join(full, e.name) }))
        .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN', { numeric: true })),
    };
  });

  // ======== NAS 连接（SMB）

  const nasBody = z.object({
    name: z.string().trim().min(1).max(30),
    host: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9.-]+$/, '地址只能是 IP 或主机名'),
    share: z.string().trim().min(1).max(100).refine((v) => !/[\\/]/.test(v), '共享名里不能有斜杠'),
    subPath: z.string().trim().max(300).default('').refine((v) => !v.split('/').includes('..'), '路径无效'),
    username: z.string().trim().min(1).max(100),
    // 修改时留空表示不改密码
    password: z.string().max(200).optional(),
    vers: z.enum(['3.1.1', '3.0', '2.1', '2.0', '1.0']).default('3.0'),
  });

  const nasView = async (n: NasSource) => {
    const libraries = immichConnected() ? await immich.getAllLibraries().catch(() => []) : [];
    const mountPath = nasMountPath(n.id);
    return {
      id: n.id,
      name: n.name,
      host: n.host,
      share: n.share,
      subPath: n.subPath,
      username: n.username,
      vers: n.vers,
      mountPath,
      status: mountState(nasTarget(n.id)),
      libraries: libraries.filter((l) => l.importPaths.some((p) => p === mountPath || p.startsWith(`${mountPath}/`))).map((l) => l.name),
    };
  };

  const mounterError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof MounterError) return reply.code(err.userFacing ? 400 : 502).send({ message: err.message });
    throw err;
  };

  app.get('/api/admin/nas', async () => {
    const backup = getBackupTarget();
    return {
      mounter: isMounterAvailable(),
      sources: await Promise.all(nasSources.list().map(nasView)),
      backup: backup ? { ...backup, status: mountState('backup') } : null,
    };
  });

  // 测试连接（不保存）：返回共享里的顶层文件夹。修改已有连接时可以传 id，不填密码就用保存的
  app.post('/api/admin/nas/test', async (req, reply) => {
    const body = nasBody.partial({ name: true }).extend({ id: z.number().int().optional(), writable: z.boolean().default(false) }).parse(req.body);
    const password = body.password || (body.id ? nasSources.get(body.id)?.password : undefined);
    if (!password) return reply.code(400).send({ message: '请填写密码' });
    try {
      return await testConnection({ ...body, password }, body.subPath, body.writable);
    } catch (err) {
      return mounterError(reply, err);
    }
  });

  app.post('/api/admin/nas', async (req, reply) => {
    const body = nasBody.parse(req.body);
    if (!body.password) return reply.code(400).send({ message: '请填写密码' });
    const src = nasSources.create({ ...body, password: body.password });
    try {
      await mountSource(src);
    } catch (err) {
      nasSources.remove(src.id);
      return mounterError(reply, err);
    }
    return reply.code(201).send(await nasView(src));
  });

  app.put('/api/admin/nas/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const current = nasSources.get(id);
    if (!current) return reply.code(404).send({ message: 'NAS 不存在' });
    const body = nasBody.parse(req.body);
    const next = { ...body, password: body.password || current.password };
    try {
      await testConnection(next, next.subPath);
    } catch (err) {
      return mounterError(reply, err);
    }
    const updated = nasSources.update(id, next)!;
    try {
      await unmountSource(id);
      await mountSource(updated);
    } catch (err) {
      return mounterError(reply, err);
    }
    return nasView(updated);
  });

  app.post('/api/admin/nas/:id/reconnect', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const src = nasSources.get(id);
    if (!src) return reply.code(404).send({ message: 'NAS 不存在' });
    try {
      await unmountSource(id);
      await mountSource(src);
    } catch (err) {
      return mounterError(reply, err);
    }
    return nasView(src);
  });

  app.delete('/api/admin/nas/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const src = nasSources.get(id);
    if (!src) return reply.code(404).send({ message: 'NAS 不存在' });
    const view = await nasView(src);
    if (view.libraries.length) return reply.code(400).send({ message: `照片库“${view.libraries.join('、')}”还在用这个 NAS，请先从照片库里去掉它的文件夹` });
    if (getBackupTarget()?.sourceId === id) return reply.code(400).send({ message: '备份位置在这个 NAS 上，请先修改备份位置' });
    await unmountSource(id).catch(() => {});
    nasSources.remove(id);
    return reply.code(204).send();
  });

  // ---- 备份位置：Immich 和宝宝相册的数据库备份写到哪里（不设置就留在本机）
  app.put('/api/admin/backup', async (req, reply) => {
    const body = z.object({ sourceId: z.number().int().nullable(), subPath: z.string().trim().max(300).default('') }).parse(req.body);
    try {
      await setBackupTarget(body.sourceId === null ? null : { sourceId: body.sourceId, subPath: body.subPath });
    } catch (err) {
      return mounterError(reply, err);
    }
    return { ok: true };
  });

  // ---- 图库（Immich 外部图库）
  const libraryBody = z.object({
    name: z.string().trim().min(1).max(50),
    importPaths: z.array(importPathSchema).min(1).max(50),
    exclusionPatterns: z.array(z.string().min(1).max(200)).max(50).optional(),
  });

  app.post('/api/admin/libraries', async (req, reply) => {
    const body = libraryBody.parse(req.body);
    const me = await immich.getMyUser();
    const library = await immich.createLibrary({
      createLibraryDto: { ownerId: me.id, name: body.name, importPaths: body.importPaths, exclusionPatterns: body.exclusionPatterns ?? DEFAULT_EXCLUSIONS },
    });
    await immich.scanLibrary({ id: library.id });
    return reply.code(201).send(library);
  });

  app.put('/api/admin/libraries/:id', async (req) => {
    const { id } = uuidParams.parse(req.params);
    const body = libraryBody.partial().parse(req.body);
    const library = await immich.updateLibrary({ id, updateLibraryDto: body });
    // 修改导入路径后马上扫描一次
    if (body.importPaths) await immich.scanLibrary({ id });
    return library;
  });

  app.post('/api/admin/libraries/:id/scan', async (req) => {
    const { id } = uuidParams.parse(req.params);
    await immich.scanLibrary({ id });
    return { ok: true };
  });

  // 从照片库中移除（只是不再管理这些照片，NAS 上的文件不受影响）
  app.delete('/api/admin/libraries/:id', async (req, reply) => {
    const { id } = uuidParams.parse(req.params);
    await immich.deleteLibrary({ id });
    clearAlbumCache();
    return reply.code(204).send();
  });

  // ======== 人物（人脸识别的结果）

  app.get('/api/admin/people', async (req) => {
    const { hidden } = z.object({ hidden: z.coerce.boolean().default(false) }).parse(req.query);
    const people: immich.PersonResponseDto[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await immich.getAllPeople({ withHidden: hidden, page, size: 500 });
      people.push(...res.people);
      if (!res.hasNextPage) break;
    }
    const linked = new Map(babies.list().map((b) => [b.immichPersonId, b]));
    const counts = await mapLimit(people, 8, (p) => immich.getPersonStatistics({ id: p.id }).then((s) => s.assets).catch(() => 0));
    return people
      .map((p, i) => ({
        id: p.id,
        name: p.name,
        birthDate: p.birthDate,
        isHidden: p.isHidden,
        assets: counts[i],
        baby: linked.has(p.id) ? { id: linked.get(p.id)!.id, name: linked.get(p.id)!.name } : null,
        thumbnailUrl: `/api/people/${p.id}/thumbnail`,
      }))
      .sort((a, b) => b.assets - a.assets);
  });

  app.put('/api/admin/people/:id', async (req) => {
    const { id } = uuidParams.parse(req.params);
    const body = z.object({ name: z.string().trim().max(50).optional(), birthDate: z.iso.date().nullable().optional(), isHidden: z.boolean().optional() }).parse(req.body);
    const p = await immich.updatePerson({ id, personUpdateDto: body });
    return { id: p.id, name: p.name, birthDate: p.birthDate, isHidden: p.isHidden };
  });

  // 合并：把 ids 里的人物合并到 :id（同一个人被识别成了几个人物，比如宝宝不同年龄段长相差别大）
  app.post('/api/admin/people/:id/merge', async (req, reply) => {
    const { id } = uuidParams.parse(req.params);
    const { ids } = z.object({ ids: z.array(z.uuid()).min(1).max(100) }).parse(req.body);
    if (ids.includes(id)) return reply.code(400).send({ message: '不能和自己合并' });
    const linked = babies.list().filter((b) => ids.includes(b.immichPersonId) || b.immichPersonId === id);
    if (linked.length > 1) return reply.code(400).send({ message: `${linked.map((b) => b.name).join('、')} 是不同的宝宝，不能合并` });
    await immich.mergePersonLegacy({ id, mergePersonDto: { ids } });
    // 被合并掉的人物如果关联了宝宝，改为关联到合并后的人物
    const moved = linked.find((b) => b.immichPersonId !== id);
    if (moved) babies.relink(moved.id, id);
    clearAlbumCache();
    return { ok: true };
  });
}
