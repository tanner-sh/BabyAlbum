// 登录与权限：宝宝相册自己的账号体系（和 Immich 无关）。
// 会话 Cookie 只保存用户 ID 和会话版本号，每次请求都从数据库读取用户，
// 所以停用账号、修改角色、修改密码都会立即生效。

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.ts';
import { immichStatus } from './immich-link.ts';
import { invites, transaction, users, type Role, type User } from './db.ts';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.ts';

const COOKIE = 'baby_session';
const MAX_AGE_SECONDS = 30 * 24 * 3600;

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

// ---------------------------------------------------------------- 输入校验

export const usernameSchema = z
  .string()
  .trim()
  .regex(/^[\p{L}\p{N}_.-]{2,32}$/u, '用户名为 2–32 个字符，可以用中文、字母、数字和 _ . -');
export const passwordSchema = z.string().min(8, '密码至少 8 位').max(200);
export const displayNameSchema = z.string().trim().min(1).max(30);

// ---------------------------------------------------------------- 会话

type SessionPayload = { uid: number; v: number; exp: number };

function readSession(req: FastifyRequest): User | null {
  const raw = req.cookies[COOKIE];
  if (!raw) return null;
  const { valid, value } = req.unsignCookie(raw);
  if (!valid || !value) return null;
  try {
    const s = JSON.parse(Buffer.from(value, 'base64url').toString()) as SessionPayload;
    if (s.exp < Date.now()) return null;
    const user = users.get(s.uid);
    return user && !user.disabled && user.sessionVersion === s.v ? user : null;
  } catch {
    return null;
  }
}

function startSession(reply: FastifyReply, user: User) {
  const payload: SessionPayload = { uid: user.id, v: user.sessionVersion, exp: Date.now() + MAX_AGE_SECONDS * 1000 };
  reply.setCookie(COOKIE, Buffer.from(JSON.stringify(payload)).toString('base64url'), {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    // 经 HTTPS（含反向代理转发的 X-Forwarded-Proto）访问时自动加 Secure，局域网 http 访问不受影响
    secure: config.COOKIE_SECURE || reply.request.protocol === 'https',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  users.touchLogin(user.id);
}

export const publicUser = (u: User) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, babyIds: u.babyIds });

// ---------------------------------------------------------------- 权限检查（用作 preHandler）

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ message: '请先登录' });
    if (!roles.includes(req.user.role)) return reply.code(403).send({ message: '没有权限' });
  };
}
export const adminOnly = requireRole('admin');
/** 能修改内容（收藏、里程碑、日期更正、分享）：管理员和家人 */
export const editors = requireRole('admin', 'member');

/** 这个用户能看哪些宝宝：管理员和没有限制的用户能看全部 */
export function canSeeBaby(user: User, babyId: number) {
  return user.role === 'admin' || user.babyIds === null || user.babyIds.includes(babyId);
}

// ---------------------------------------------------------------- 路由

// 不需要登录的接口：首次设置、登录、注册（邀请）、健康检查、分享链接（有自己的 token 校验）
const PUBLIC = [/^\/api\/setup$/, /^\/api\/auth\/(login|register)$/, /^\/api\/invites\/[^/]+$/, /^\/api\/health$/, /^\/api\/share\//];

// 简单的登录限流：同一 IP 15 分钟内最多失败 10 次
const failures = new Map<string, { count: number; until: number }>();
function tooManyFailures(ip: string) {
  const f = failures.get(ip);
  return !!f && f.until > Date.now() && f.count >= 10;
}
function recordFailure(ip: string) {
  const f = failures.get(ip);
  const prev = f && f.until > Date.now() ? f.count : 0;
  failures.set(ip, { count: prev + 1, until: Date.now() + 15 * 60_000 });
}

// 直接挂在根实例上（不通过 app.register），这样鉴权钩子对所有路由生效
export function setupAuth(app: FastifyInstance) {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req, reply) => {
    req.user = readSession(req);
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || PUBLIC.some((re) => re.test(path))) return;
    if (!req.user) return reply.code(401).send({ message: '请先登录' });
  });

  // ---- 首次设置：还没有任何用户时，创建第一个管理员
  app.get('/api/setup', async () => ({ needsSetup: users.count() === 0, immich: immichStatus() }));

  app.post('/api/setup', async (req, reply) => {
    const body = z.object({ username: usernameSchema, displayName: displayNameSchema, password: passwordSchema }).parse(req.body);
    const passwordHash = await hashPassword(body.password);
    // 在事务里检查，避免两个人同时提交时创建出两个“第一个管理员”
    const user = transaction(() => (users.count() === 0 ? users.create({ ...body, passwordHash, role: 'admin', babyIds: null }) : null));
    if (!user) return reply.code(409).send({ message: '已经设置过了，请直接登录' });
    startSession(reply, user);
    return publicUser(user);
  });

  // ---- 登录
  app.post('/api/auth/login', async (req, reply) => {
    if (tooManyFailures(req.ip)) return reply.code(429).send({ message: '尝试次数过多，请 15 分钟后再试' });
    const { username, password } = z.object({ username: z.string().trim().min(1), password: z.string().min(1) }).parse(req.body);
    const found = users.byUsername(username);
    // 用户不存在时也算一次哈希，响应时间一致
    const ok = await verifyPassword(password, found?.passwordHash ?? DUMMY_HASH);
    if (!found || !ok) {
      recordFailure(req.ip);
      return reply.code(401).send({ message: '用户名或密码错误' });
    }
    if (found.user.disabled) return reply.code(403).send({ message: '这个账号已被停用' });
    failures.delete(req.ip);
    startSession(reply, found.user);
    return publicUser(found.user);
  });

  app.get('/api/auth/me', async (req) => publicUser(req.user!));

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  // ---- 修改自己的密码（其他设备上的登录会失效，当前设备保持登录）
  app.put('/api/auth/password', async (req, reply) => {
    const { current, next } = z.object({ current: z.string().min(1), next: passwordSchema }).parse(req.body);
    const found = users.byUsername(req.user!.username)!;
    if (!(await verifyPassword(current, found.passwordHash))) return reply.code(400).send({ message: '当前密码不正确' });
    users.setPassword(req.user!.id, await hashPassword(next));
    startSession(reply, users.get(req.user!.id)!);
    return reply.code(204).send();
  });

  // ---- 邀请注册
  const validInvite = (token: string) => {
    const invite = invites.get(token);
    return invite && !invite.usedBy && invite.expiresAt > new Date().toISOString() ? invite : null;
  };

  app.get('/api/invites/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10).max(64) }).parse(req.params);
    const invite = validInvite(token);
    if (!invite) return reply.code(404).send({ message: '邀请链接无效、已使用或已过期' });
    return { role: invite.role, note: invite.note, expiresAt: invite.expiresAt };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const body = z
      .object({ token: z.string().min(10).max(64), username: usernameSchema, displayName: displayNameSchema, password: passwordSchema })
      .parse(req.body);
    const passwordHash = await hashPassword(body.password);
    const result = transaction(() => {
      const invite = validInvite(body.token);
      if (!invite) return { error: '邀请链接无效、已使用或已过期' };
      if (users.byUsername(body.username)) return { error: '这个用户名已经被用了' };
      const user = users.create({ username: body.username, displayName: body.displayName, passwordHash, role: invite.role, babyIds: invite.babyIds });
      invites.markUsed(body.token, user.id);
      return { user };
    });
    if ('error' in result) return reply.code(400).send({ message: result.error });
    startSession(reply, result.user!);
    return publicUser(result.user!);
  });
}

export const newToken = () => randomBytes(18).toString('base64url');
