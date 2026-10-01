import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { setupAuth } from './auth.ts';
import { scheduleBackups } from './backup.ts';
import { config } from './config.ts';
import { connectImmichInBackground, immichConnected } from './immich-link.ts';
import { startNasReconcile } from './nas.ts';
import { startStorageUsage } from './storage-usage.ts';
import { startImportProgress } from './import-progress.ts';
import { pushRoutes, startPushScheduler } from './push.ts';
import { rememberHttpsHost, startHealthChecks } from './health.ts';
import { immich, ImmichNotConnectedError } from './immich.ts';
import { adminRoutes } from './routes/admin.ts';
import { albumRoutes } from './routes/albums.ts';
import { manageRoutes } from './routes/manage.ts';
import { shareRoutes } from './routes/share.ts';

const app = Fastify({ logger: true, trustProxy: true });

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ZodError) {
    return reply.code(400).send({ message: '参数错误', issues: err.issues });
  }
  // Immich 还没连接好、或者暂时连不上
  const unreachable = err instanceof TypeError && err.message === 'fetch failed';
  if (err instanceof ImmichNotConnectedError || unreachable || (immich.isHttpError(err) && err.status === 401 && !immichConnected())) {
    return reply.code(503).send({ message: '照片服务（Immich）还没有连接好，请稍后再试', code: 'IMMICH_UNAVAILABLE' });
  }
  if (immich.isHttpError(err)) {
    // Immich 对“不存在或无权访问”返回 400（我们的参数已经先用 zod 校验过），统一视为 404；其他错误视为上游故障
    const status = err.status === 400 || err.status === 404 ? 404 : 502;
    req.log.warn({ status: err.status, data: err.data }, 'Immich 请求失败');
    return reply.code(status).send({ message: status === 404 ? '不存在' : 'Immich 请求失败' });
  }
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status < 500) return reply.code(status).send({ message: (err as Error).message });
  req.log.error(err);
  return reply.code(500).send({ message: '服务器内部错误' });
});

await app.register(cookie, { secret: config.SESSION_SECRET });

// 记下家人通过 HTTPS 访问的地址，系统状态页用它检查证书
app.addHook('onRequest', async (req) => {
  if (req.protocol === 'https') rememberHttpsHost(req.host);
});
setupAuth(app);

app.get('/api/health', async () => ({ ok: true, immich: immichConnected() ? 'connected' : 'not_connected' }));

await app.register(manageRoutes);
await app.register(albumRoutes);
await app.register(adminRoutes);
await app.register(shareRoutes);
await app.register(pushRoutes);

// 前端（React 构建产物）。其余路径都返回 index.html，由前端路由处理
if (existsSync(join(config.WEB_DIR, 'index.html'))) {
  await app.register(fastifyStatic, { root: config.WEB_DIR, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.method !== 'GET') return reply.code(404).send({ message: '接口不存在' });
    return reply.header('cache-control', 'no-cache').sendFile('index.html');
  });
} else {
  app.log.warn(`未找到前端构建产物 ${config.WEB_DIR}，只提供 API`);
}

await app.listen({ port: config.PORT, host: '0.0.0.0' });

if (config.BACKUP_DIR) scheduleBackups(config.BACKUP_DIR, app.log);
void connectImmichInBackground(app.log);
startNasReconcile(app.log);
startStorageUsage(app.log);
startImportProgress(app.log);
startPushScheduler(app.log);
startHealthChecks(app.log);
