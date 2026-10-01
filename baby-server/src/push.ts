// 手机推送（Web Push）：添加到主屏幕后，可以在宝宝生日、满月那天收到回顾提醒。
// 推送密钥（VAPID）第一次用到时自动生成，保存在数据库里

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import webpush from 'web-push';
import { z } from 'zod';
import { computeAge, localToday } from './age.ts';
import { canSeeBaby } from './auth.ts';
import { babies, pushSubscriptions, settings, users, type Baby } from './db.ts';

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

/** 发给一个用户的所有设备；设备取消了订阅（404/410）就删掉 */
async function sendToUser(userId: number, message: PushMessage, log: FastifyBaseLogger) {
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
      else log.warn({ err, status }, '推送失败');
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
      if (user && !user.disabled && canSeeBaby(user, baby.id)) await sendToUser(userId, message, log);
    }
    log.info(`已推送：${message.title}`);
  }
}

export function startPushScheduler(log: FastifyBaseLogger) {
  setInterval(() => void dailyCheck(log).catch((err) => log.warn({ err }, '每日推送失败')), CHECK_MS).unref();
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

  // 发一条测试通知到自己的所有设备
  app.post('/api/push/test', async (req, reply) => {
    const sent = await sendToUser(req.user!.id, { title: '宝宝相册', body: '通知已经打开，宝宝生日和满月那天会提醒你看回顾', url: '/' }, req.log);
    if (!sent) return reply.code(400).send({ message: '这台设备还没有打开通知' });
    return { sent };
  });
}
