// 连接 Immich：宝宝相册把 Immich 当成后台服务使用，用户不需要打开 Immich 的界面。
//
// 启动时自动完成：
//   - Immich 是全新的：创建一个内部服务账号（Immich 管理员）和 API 密钥，保存在宝宝相册的数据库里
//   - 已经保存过密钥：检查是否还有效
//   - Immich 已经被初始化过、但没有密钥（比如接入一个原来就在用的 Immich）：
//     等管理员在网页上输入一次 Immich 管理员账号密码来连接
// 连接后应用推荐设置（只在第一次连接时），之后由管理员在“系统设置”里调整

import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.ts';
import { settings } from './db.ts';
import { immich, setImmichKey } from './immich.ts';

export type ImmichState = 'connecting' | 'unreachable' | 'needs_credentials' | 'connected';

const SERVICE_EMAIL = 'baby-album@service.local';
const KEY_NAME = 'baby-album';

let state: ImmichState = 'connecting';
let lastError: string | null = null;

export const immichStatus = () => ({ state, error: lastError });
export const immichConnected = () => state === 'connected';

/** 用 Bearer 令牌调用（初始化阶段还没有 API 密钥） */
const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

async function createKeyWithLogin(email: string, password: string) {
  const login = await immich.login({ loginCredentialDto: { email, password } });
  if (!login.isAdmin) throw new Error('这个 Immich 账号不是管理员');
  const { secret } = await immich.createApiKey(
    { apiKeyCreateDto: { name: KEY_NAME, permissions: [immich.Permission.All] } },
    bearer(login.accessToken),
  );
  // 只用来创建密钥，用完就注销这个会话
  await immich.logout(bearer(login.accessToken)).catch(() => {});
  return secret;
}

async function useKey(key: string): Promise<boolean> {
  setImmichKey(key);
  try {
    const me = await immich.getMyUser();
    if (!me.isAdmin) throw new Error('API 密钥所属的 Immich 账号不是管理员');
    return true;
  } catch (err) {
    setImmichKey(null);
    if (immich.isHttpError(err) && err.status === 401) return false;
    throw err;
  }
}

/** 第一次连接时应用的推荐设置 */
async function applyRecommendedSettings(log: FastifyBaseLogger) {
  if (settings.get('immich.defaultsApplied')) return;
  const cfg = await immich.getConfig();
  // 手机和相机拍的视频大多是 HEVC，现在的浏览器大多能直接播放；Immich 默认只接受 H.264，
  // 不改的话会把所有视频转码一遍（几 TB 的视频要转好几天）。需要时管理员可以在设置里打开
  cfg.ffmpeg.transcode = immich.TranscodePolicy.Disabled;
  await immich.updateConfig({ adminConfigDto: cfg });
  settings.set('immich.defaultsApplied', new Date().toISOString());
  log.info('已应用 Immich 推荐设置（视频不转码）');
}

async function connectOnce(log: FastifyBaseLogger): Promise<ImmichState> {
  try {
    await immich.pingServer();
  } catch {
    return 'unreachable';
  }

  const stored = settings.get('immich.apiKey') ?? config.IMMICH_API_KEY;
  if (stored) {
    if (await useKey(stored)) {
      if (!settings.get('immich.apiKey')) settings.set('immich.apiKey', stored);
      return 'connected';
    }
    log.warn('保存的 Immich API 密钥已失效');
    settings.remove('immich.apiKey');
  }

  const { isInitialized } = await immich.getServerConfig();
  if (isInitialized) {
    // 服务账号是我们自己建的，密码还在的话直接重新生成密钥
    const email = settings.get('immich.serviceEmail');
    const password = settings.get('immich.servicePassword');
    if (email && password) {
      const key = await createKeyWithLogin(email, password).catch(() => null);
      if (key && (await useKey(key))) {
        settings.set('immich.apiKey', key);
        return 'connected';
      }
    }
    return 'needs_credentials';
  }

  // 全新的 Immich：创建内部服务账号
  const password = randomBytes(24).toString('base64url');
  await immich.signUpAdmin({ signUpDto: { email: SERVICE_EMAIL, name: '宝宝相册', password } });
  settings.set('immich.serviceEmail', SERVICE_EMAIL);
  settings.set('immich.servicePassword', password);
  const key = await createKeyWithLogin(SERVICE_EMAIL, password);
  await useKey(key);
  settings.set('immich.apiKey', key);
  log.info('已自动初始化 Immich 并创建服务账号');
  return 'connected';
}

/** 启动时在后台连接，Immich 还没起来就每 5 秒重试一次，不阻塞宝宝相册启动 */
export async function connectImmichInBackground(log: FastifyBaseLogger) {
  for (;;) {
    try {
      state = await connectOnce(log);
      lastError = null;
    } catch (err) {
      state = 'unreachable';
      lastError = err instanceof Error ? err.message : String(err);
      log.warn(err, '连接 Immich 失败');
    }
    if (state === 'connected') {
      await applyRecommendedSettings(log).catch((err) => log.warn(err, '应用 Immich 推荐设置失败'));
      log.info('Immich 已连接');
      return;
    }
    if (state === 'needs_credentials') {
      log.warn('这个 Immich 已经被初始化过，请管理员在“照片库”页面用 Immich 管理员账号连接');
      return;
    }
    await sleep(5000);
  }
}

/** 管理员用一个已有的 Immich 管理员账号连接 */
export async function connectWithCredentials(email: string, password: string, log: FastifyBaseLogger) {
  const key = await createKeyWithLogin(email, password);
  if (!(await useKey(key))) throw new Error('创建的 API 密钥无效');
  settings.set('immich.apiKey', key);
  state = 'connected';
  lastError = null;
  await applyRecommendedSettings(log).catch((err) => log.warn(err, '应用 Immich 推荐设置失败'));
}
