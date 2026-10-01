// 手机推送（Web Push）：添加到主屏幕后，可以在宝宝生日、满月那天收到回顾提醒。
// 推送密钥（VAPID）第一次用到时自动生成，保存在数据库里

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import webpush from 'web-push';
import { z } from 'zod';
import { computeAge, localToday, shiftDays } from './age.ts';
import { canSeeBaby } from './auth.ts';
import { babies, notifyPrefs, pushSubscriptions, settings, users, type Baby, type NotifyPrefs } from './db.ts';
import { immich } from './immich.ts';

const CHECK_MS = 10 * 60_000;
/** 每天几点发 */
const SEND_HOUR = 9;
// 推送服务（苹果、谷歌）要求提供一个联系方式，用项目主页
const SUBJECT = 'https://github.com/tanner-sh/BabyAlbum';

function vapidKeys() {
  let publicKey = settings.get('push.vapidPublicKey');
  let privateKey = settings.get('push.vapidPrivateKey');
  if (!publicKey || !privateKey) {
    ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
    settings.set('push.vapidPublicKey', publicKey);
    settings.set('push.vapidPrivateKey', privateKey);
  }
  return { publicKey, privateKey };
}

export type PushMessage = { title: string; body: string; url: string };

/** 推送分几类，每个人可以分别关掉：生日满月回顾、每周小结、家人互动、系统提醒（管理员） */
export type PushKind = keyof NotifyPrefs;

/** 最近一次推送失败的原因（系统状态页用） */
let lastFailure: { at: string; message: string } | null = null;
export const pushFailure = () => lastFailure;

/** 发给一个用户的所有设备；设备取消了订阅（404/410）就删掉 */
async function sendToUser(userId: number, message: PushMessage, log: FastifyBaseLogger, kind?: PushKind) {
  if (kind && !notifyPrefs.get(userId)[kind]) return 0;
  const { publicKey, privateKey } = vapidKeys();
  let sent = 0;
  for (const sub of pushSubscriptions.forUser(userId)) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(message), {
        TTL: 24 * 3600,
        vapidDetails: { subject: SUBJECT, publicKey, privateKey },
      });
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) pushSubscriptions.remove(sub.endpoint);
      else {
        log.warn({ err, status }, '推送失败');
        lastFailure = { at: new Date().toISOString(), message: status ? `推送服务返回 ${status}` : err instanceof Error ? err.message : String(err) };
      }
    }
  }
  return sent;
}

/** 今天有什么值得提醒的：生日（x 岁回顾），3 岁以内的满月（这个月的精选） */
export function todaysEvents(baby: Baby, today = localToday()): PushMessage | null {
  const age = computeAge(baby.birthday, today);
  if (age.days <= 0 || age.extraDays !== 0) return null;
  if (age.months % 12 === 0) {
    const years = age.months / 12;
    return {
      title: `${baby.name} ${years} 岁生日快乐 🎂`,
      body: `看看${baby.name}这一年的精选照片`,
      url: `/baby/${baby.id}?tab=review&kind=year&index=${years - 1}`,
    };
  }
  if (age.months < 36) {
    return {
      title: `${baby.name}满 ${age.months} 个月啦`,
      body: '看看这个月的精选照片',
      url: `/baby/${baby.id}?tab=review&kind=month&index=${age.months - 1}`,
    };
  }
  return null;
}

async function dailyCheck(log: FastifyBaseLogger) {
  const today = localToday();
  if (new Date().getHours() < SEND_HOUR || settings.get('push.lastSent') === today) return;
  settings.set('push.lastSent', today);
  const subscribers = new Set(pushSubscriptions.all().map((s) => s.userId));
  if (!subscribers.size) return;
  for (const baby of babies.list()) {
    const message = todaysEvents(baby, today);
    if (!message) continue;
    for (const userId of subscribers) {
      const user = users.get(userId);
      if (user && !user.disabled && canSeeBaby(user, baby.id)) await sendToUser(userId, message, log, 'milestones');
    }
    log.info(`已推送：${message.title}`);
  }
}

// ---------------------------------------------------------------- 每周小结：周日晚上 8 点

const WEEKLY_DAY = 0;
const WEEKLY_HOUR = 20;

/** 这周（最近 7 天）拍的有宝宝的照片数 */
async function weekCount(baby: Baby) {
  const { total } = await immich.searchAssetStatistics({
    statisticsSearchDto: {
      personIds: [baby.immichPersonId],
      takenAfter: `${shiftDays(localToday(), -6)}T00:00:00.000Z`,
      visibility: immich.AssetVisibility.Timeline,
    },
  });
  return total;
}

export async function weeklyMessage(userId: number): Promise<PushMessage | null> {
  const user = users.get(userId);
  if (!user || user.disabled) return null;
  const list = babies.list().filter((b) => canSeeBaby(user, b.id));
  const counts = await Promise.all(list.map(async (b) => ({ baby: b, count: await weekCount(b).catch(() => 0) })));
  const withPhotos = counts.filter((c) => c.count > 0);
  if (!withPhotos.length) return null;
  return {
    title: '这周的照片',
    body: `${withPhotos.map((c) => `${c.baby.name} ${c.count} 张`).join('，')}，来看看吧`,
    url: withPhotos.length === 1 ? `/baby/${withPhotos[0].baby.id}` : '/',
  };
}

async function weeklyCheck(log: FastifyBaseLogger) {
  const now = new Date();
  const today = localToday();
  if (now.getDay() !== WEEKLY_DAY || now.getHours() < WEEKLY_HOUR || settings.get('push.weeklySent') === today) return;
  settings.set('push.weeklySent', today);
  for (const userId of new Set(pushSubscriptions.all().map((s) => s.userId))) {
    const message = await weeklyMessage(userId);
    if (message) await sendToUser(userId, message, log, 'weekly');
  }
}

// ---------------------------------------------------------------- 家人互动、系统提醒

/** 能看所有照片的家人（管理员、没有限制的家人），互动提醒发给他们 */
const fullAccessUsers = () => users.list().filter((u) => !u.disabled && u.role !== 'viewer' && (u.role === 'admin' || u.babyIds === null));

// 同一个人对同一张照片的点赞、取消、再点赞，一天只提醒一次
const notified = new Map<string, number>();
let pushLog: FastifyBaseLogger | null = null;

/** 有人点赞、留言：提醒家里人（不提醒自己） */
export function notifyInteraction(e: { assetId: string; actor: string; text: string }) {
  const key = `${e.actor}:${e.assetId}:${e.text.slice(0, 20)}`;
  if ((notified.get(key) ?? 0) > Date.now() - 24 * 3600_000) return;
  notified.set(key, Date.now());
  const log = pushLog;
  if (!log) return;
  for (const u of fullAccessUsers()) {
    if (e.actor === `u:${u.id}`) continue;
    void sendToUser(u.id, { title: '家人的互动', body: e.text.slice(0, 100), url: `/asset/${e.assetId}` }, log, 'family');
  }
}

/** 给管理员发系统提醒（系统状态有问题时） */
export async function notifyAdmins(message: PushMessage) {
  const log = pushLog;
  if (!log) return 0;
  let sent = 0;
  for (const u of users.list()) if (u.role === 'admin' && !u.disabled) sent += await sendToUser(u.id, message, log, 'system');
  return sent;
}

export function startPushScheduler(log: FastifyBaseLogger) {
  pushLog = log;
  setInterval(() => {
    void dailyCheck(log).catch((err) => log.warn({ err }, '每日推送失败'));
    void weeklyCheck(log).catch((err) => log.warn({ err }, '每周小结推送失败'));
  }, CHECK_MS).unref();
}

const subscriptionBody = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

export async function pushRoutes(app: FastifyInstance) {
  app.get('/api/push/key', async () => ({ publicKey: vapidKeys().publicKey }));

  app.post('/api/push/subscribe', async (req) => {
    const { endpoint, keys } = subscriptionBody.parse(req.body);
    pushSubscriptions.save({ endpoint, userId: req.user!.id, p256dh: keys.p256dh, auth: keys.auth });
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', async (req) => {
    const { endpoint } = z.object({ endpoint: z.string().max(2000) }).parse(req.body);
    const own = pushSubscriptions.forUser(req.user!.id).some((s) => s.endpoint === endpoint);
    if (own) pushSubscriptions.remove(endpoint);
    return { ok: true };
  });

  // 想收到哪些提醒
  const prefsBody = z.object({ milestones: z.boolean(), weekly: z.boolean(), family: z.boolean(), system: z.boolean() }).partial();
  app.get('/api/push/prefs', async (req) => notifyPrefs.get(req.user!.id));
  app.put('/api/push/prefs', async (req) => notifyPrefs.set(req.user!.id, prefsBody.parse(req.body)));

  // 预览这周的小结（不发送）
  app.get('/api/push/weekly-preview', async (req) => (await weeklyMessage(req.user!.id)) ?? { title: '这周的照片', body: '这周还没有新照片', url: '/' });

  // 发一条测试通知到自己的所有设备
  app.post('/api/push/test', async (req, reply) => {
    const sent = await sendToUser(req.user!.id, { title: '宝宝相册', body: '通知已经打开，宝宝生日和满月那天会提醒你看回顾', url: '/' }, req.log);
    if (!sent) return reply.code(400).send({ message: '这台设备还没有打开通知' });
    return { sent };
  });
}
