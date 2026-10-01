import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { defaults, setApiKey, setBaseUrl } from '@immich/sdk';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.ts';

// 所有对 Immich 的调用都通过 @immich/sdk 走 API，不直接读写 Immich 的数据库。
// API 密钥由 immich-link.ts 在连接成功后设置（自动初始化或管理员连接），不再写在配置文件里
setBaseUrl(`${config.IMMICH_URL}/api`);

export * as immich from '@immich/sdk';

let currentKey: string | null = null;

export function setImmichKey(key: string | null) {
  currentKey = key;
  if (key) setApiKey(key);
  else if (defaults.headers) delete (defaults.headers as Record<string, unknown>)['x-api-key'];
}

export const immichKey = () => currentKey;

/** Immich 还没连接好时抛出，统一返回 503 */
export class ImmichNotConnectedError extends Error {
  constructor() {
    super('照片服务（Immich）还没有连接好');
  }
}

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

/**
 * 以流的方式转发 Immich 的媒体文件（缩略图、视频、原图），支持 Range 请求（视频拖动进度条需要）。
 * 前端不需要持有 Immich 的 API 密钥。
 */
export async function proxyMedia(
  req: FastifyRequest,
  reply: FastifyReply,
  path: string,
  opts: { cacheSeconds?: number; download?: boolean } = {},
) {
  if (!currentKey) throw new ImmichNotConnectedError();
  const headers: Record<string, string> = { 'x-api-key': currentKey };
  if (req.headers.range) headers.range = req.headers.range;
  // 超时只限制等待响应头的时间，不能限制整个响应体，否则长视频播放到一半会被掐断；
  // 浏览器断开（比如拖动进度条、关掉页面）时同时取消对 Immich 的请求
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  reply.raw.on('close', () => controller.abort());
  let res: Response;
  try {
    res = await fetch(`${config.IMMICH_URL}/api${path}`, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok && res.status !== 206) {
    await res.body?.cancel();
    // Immich 对“不存在或无权访问”返回 400
    const notFound = res.status === 400 || res.status === 404;
    return reply.code(notFound ? 404 : 502).send({ message: notFound ? '文件不存在' : 'Immich 请求失败' });
  }

  reply.code(res.status);
  for (const h of PASS_HEADERS) {
    const v = res.headers.get(h);
    if (v) reply.header(h, v);
  }
  reply.header('cache-control', opts.cacheSeconds ? `private, max-age=${opts.cacheSeconds}` : 'private, no-cache');
  if (opts.download) {
    const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('content-disposition') ?? '')?.[1];
    reply.header('content-disposition', `attachment${name ? `; filename*=UTF-8''${name}` : ''}`);
  }
  return reply.send(res.body ? Readable.fromWeb(res.body as ReadableStream) : null);
}
