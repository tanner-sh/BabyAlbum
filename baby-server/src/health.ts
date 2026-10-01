// 系统状态：定期检查宝宝相册依赖的各项服务，出问题时提醒管理员。
// 比如 DNS 解析坏了（推送发不出去、证书续不了期）、证书快到期、存储断开、备份失败、导入卡住

import { lookup } from 'node:dns/promises';
import { connect } from 'node:tls';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.ts';
import { nasSources, settings } from './db.ts';
import { immichConnected, immichStatus } from './immich-link.ts';
import { immich } from './immich.ts';
import { importProgress } from './import-progress.ts';
import { getBackupTarget, isMounterAvailable, mountState, nasTarget } from './nas.ts';
import { notifyAdmins, pushFailure } from './push.ts';

export type HealthStatus = 'ok' | 'warn' | 'error' | 'skip';
export type HealthCheck = { key: string; label: string; status: HealthStatus; message: string; hint?: string };

const CHECK_MS = 5 * 60_000;
/** 一直有问题时，每隔多久再提醒一次 */
const REMIND_MS = 24 * 3600_000;

let last: { checkedAt: string; checks: HealthCheck[] } | null = null;
export const healthReport = () => last;

// ---------------------------------------------------------------- 对外访问的地址（检查证书用）
// 不需要配置：家人通过 HTTPS 访问时自动记下访问的地址（经反向代理时取转发过来的 Host）

let publicHost = settings.get('public.httpsHost') ?? null;
export function rememberHttpsHost(host: string | undefined) {
  if (!host || host === publicHost || !/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return;
  publicHost = host;
  settings.set('public.httpsHost', host);
}

// ---------------------------------------------------------------- 各项检查

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('超时')), ms))]);

async function checkImmich(): Promise<HealthCheck> {
  const s = immichStatus();
  return s.state === 'connected'
    ? { key: 'immich', label: '照片服务', status: 'ok', message: '运行正常' }
    : { key: 'immich', label: '照片服务', status: 'error', message: s.error ?? '还没有连接上', hint: '照片、缩略图、人脸识别都依赖它。看看 Immich 的容器有没有在运行' };
}

function checkStorage(): HealthCheck {
  const sources = nasSources.list();
  if (!sources.length) return { key: 'storage', label: '存储', status: 'skip', message: '还没有添加存储' };
  if (!isMounterAvailable()) return { key: 'storage', label: '存储', status: 'error', message: '挂载服务没有运行', hint: '看看 nas-mounter 容器有没有在运行' };
  const bad = sources.filter((s) => mountState(nasTarget(s.id)).state === 'error');
  return bad.length
    ? {
        key: 'storage',
        label: '存储',
        status: 'error',
        message: bad.map((s) => `“${s.name}”连不上：${mountState(nasTarget(s.id)).error ?? '未知原因'}`).join('；'),
        hint: '检查 NAS 有没有开机、网络是否正常、账号密码有没有改过',
      }
    : { key: 'storage', label: '存储', status: 'ok', message: `${sources.length} 个存储都正常` };
}

/** 能不能解析外网域名：推送通知、证书续期、下载模型都要用 */
async function checkDns(): Promise<HealthCheck> {
  const hosts = ['web.push.apple.com', 'fcm.googleapis.com', 'acme-v02.api.letsencrypt.org'];
  const results = await Promise.all(hosts.map((h) => withTimeout(lookup(h), 5000).then(() => true, () => false)));
  const failed = hosts.filter((_, i) => !results[i]);
  if (!failed.length) return { key: 'dns', label: '域名解析', status: 'ok', message: '外网域名解析正常' };
  return {
    key: 'dns',
    label: '域名解析',
    status: failed.length === hosts.length ? 'error' : 'warn',
    message: `解析不了：${failed.join('、')}`,
    hint: '推送提醒会发不出去，HTTPS 证书也可能续不了期。浏览器能上网但这里不行时，多半是电脑上的代理、VPN 软件让系统的域名解析卡住了，重启一下这些软件的网络功能试试',
  };
}

async function checkCertificate(): Promise<HealthCheck> {
  if (!publicHost) return { key: 'cert', label: 'HTTPS 证书', status: 'skip', message: '还没有通过 HTTPS 访问过，不检查' };
  const [host, port] = publicHost.split(':');
  try {
    const validTo = await withTimeout(
      new Promise<Date>((resolve, reject) => {
        const socket = connect({ host, port: Number(port ?? 443), servername: host, rejectUnauthorized: false }, () => {
          const cert = socket.getPeerCertificate();
          socket.end();
          cert?.valid_to ? resolve(new Date(cert.valid_to)) : reject(new Error('拿不到证书'));
        });
        socket.on('error', reject);
      }),
      10_000,
    );
    const days = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
    const status: HealthStatus = days < 3 ? 'error' : days < 14 ? 'warn' : 'ok';
    return {
      key: 'cert',
      label: 'HTTPS 证书',
      status,
      message: days < 0 ? `${publicHost} 的证书已经过期` : `${publicHost} 的证书还有 ${days} 天到期`,
      hint: status === 'ok' ? undefined : '证书一般会在到期前 30 天自动续期，快到期还没续说明续期失败了，检查反向代理（比如 Caddy）的日志和域名解析',
    };
  } catch (err) {
    return {
      key: 'cert',
      label: 'HTTPS 证书',
      status: 'warn',
      message: `从这台电脑连不上 ${publicHost}：${err instanceof Error ? err.message : err}`,
      hint: '可能是路由器不支持从内网访问自己的公网地址，不一定有问题。从外网打开试试',
    };
  }
}

function checkBackup(): HealthCheck {
  if (!config.BACKUP_DIR) return { key: 'backup', label: '备份', status: 'warn', message: '没有设置备份', hint: '日记、成长数据、里程碑只存在这台电脑上' };
  const lastOk = settings.get('backup.lastOk');
  const lastError = JSON.parse(settings.get('backup.lastError') ?? 'null') as { at: string; message: string } | null;
  if (lastError && (!lastOk || lastError.at > lastOk)) {
    return { key: 'backup', label: '备份', status: 'error', message: `最近一次备份失败：${lastError.message}`, hint: '检查备份位置的存储是否连得上、还有没有空间' };
  }
  if (!lastOk) return { key: 'backup', label: '备份', status: 'warn', message: '还没有备份过' };
  const hours = (Date.now() - Date.parse(lastOk)) / 3600_000;
  if (hours > 36) return { key: 'backup', label: '备份', status: 'warn', message: `上次备份是 ${Math.round(hours / 24)} 天前` };
  if (!getBackupTarget()) {
    return {
      key: 'backup',
      label: '备份',
      status: 'warn',
      message: '备份只存在这台电脑上',
      hint: '这台电脑的硬盘坏了，备份会和数据一起丢失。在“照片库 → 存储”里把备份位置设到 NAS 上',
    };
  }
  return { key: 'backup', label: '备份', status: 'ok', message: `${Math.round(hours)} 小时前备份过` };
}

async function checkDisk(): Promise<HealthCheck> {
  if (!immichConnected()) return { key: 'disk', label: '磁盘空间', status: 'skip', message: '照片服务没连上，不检查' };
  const s = await immich.getStorage();
  const free = s.diskAvailableRaw / s.diskSizeRaw;
  const gb = (s.diskAvailableRaw / 1024 ** 3).toFixed(1);
  const status: HealthStatus = free < 0.03 ? 'error' : free < 0.1 ? 'warn' : 'ok';
  return {
    key: 'disk',
    label: '磁盘空间',
    status,
    message: `缩略图所在的磁盘还剩 ${gb} GB（${Math.round(free * 100)}%）`,
    hint: status === 'ok' ? undefined : '空间用完后新照片的缩略图会生成失败。清理一下这台电脑的磁盘',
  };
}

function checkImport(): HealthCheck {
  const p = importProgress();
  const meta = p.stages.find((s) => s.name === immich.QueueName.MetadataExtraction);
  if (!p.importing) return { key: 'import', label: '导入', status: 'ok', message: '没有正在导入的照片' };
  // 采样满一个小时后，读取拍摄信息还一点没动，就算卡住了
  if (meta && meta.remaining > 0 && p.sampledMinutes >= 60 && meta.ratePerHour === null) {
    return { key: 'import', label: '导入', status: 'warn', message: `最近一小时没有进展，还剩 ${meta.remaining.toLocaleString()} 个文件`, hint: '看看存储有没有断开、照片服务有没有在运行' };
  }
  return { key: 'import', label: '导入', status: 'ok', message: `正在导入，还剩 ${(meta?.remaining ?? 0).toLocaleString()} 个文件读取拍摄信息` };
}

async function checkQueues(): Promise<HealthCheck> {
  if (!immichConnected()) return { key: 'queues', label: '后台任务', status: 'skip', message: '照片服务没连上，不检查' };
  const failed = (await immich.getQueues()).filter((q) => q.statistics.failed > 0);
  return failed.length
    ? {
        key: 'queues',
        label: '后台任务',
        status: 'warn',
        message: `有失败的任务：${failed.map((q) => `${q.name} ${q.statistics.failed} 个`).join('、')}`,
        hint: '个别文件损坏也会失败，不一定要处理。可以在“照片库 → 后台处理”里补跑',
      }
    : { key: 'queues', label: '后台任务', status: 'ok', message: '没有失败的任务' };
}

function checkPush(): HealthCheck {
  const f = pushFailure();
  if (f && Date.now() - Date.parse(f.at) < 24 * 3600_000) {
    return { key: 'push', label: '推送提醒', status: 'warn', message: `最近一次推送失败：${f.message}`, hint: '常见原因是域名解析或网络有问题' };
  }
  return { key: 'push', label: '推送提醒', status: 'ok', message: '最近没有推送失败' };
}

const CHECKS: { key: string; label: string; run: () => HealthCheck | Promise<HealthCheck> }[] = [
  { key: 'immich', label: '照片服务', run: checkImmich },
  { key: 'storage', label: '存储', run: checkStorage },
  { key: 'dns', label: '域名解析', run: checkDns },
  { key: 'cert', label: 'HTTPS 证书', run: checkCertificate },
  { key: 'backup', label: '备份', run: checkBackup },
  { key: 'disk', label: '磁盘空间', run: checkDisk },
  { key: 'import', label: '导入', run: checkImport },
  { key: 'queues', label: '后台任务', run: checkQueues },
  { key: 'push', label: '推送提醒', run: checkPush },
];

export async function runHealthChecks(log: FastifyBaseLogger) {
  const checks = await Promise.all(
    CHECKS.map(async (c): Promise<HealthCheck> => {
      try {
        return await c.run();
      } catch (err) {
        return { key: c.key, label: c.label, status: 'warn', message: `检查时出错：${err instanceof Error ? err.message : err}` };
      }
    }),
  );
  last = { checkedAt: new Date().toISOString(), checks };
  await alert(checks, log);
  return last;
}

// ---------------------------------------------------------------- 出问题时提醒管理员

async function alert(checks: HealthCheck[], log: FastifyBaseLogger) {
  const notified = JSON.parse(settings.get('health.notified') ?? '{}') as Record<string, string>;
  const now = Date.now();
  const problems = checks.filter((c) => c.status === 'error' || (c.status === 'warn' && ['dns', 'cert', 'storage'].includes(c.key)));
  const fresh = problems.filter((c) => !notified[c.key] || now - Date.parse(notified[c.key]) > REMIND_MS);
  // 恢复正常的，下次再出问题马上提醒
  for (const key of Object.keys(notified)) if (!problems.some((c) => c.key === key)) delete notified[key];
  if (fresh.length) {
    const sent = await notifyAdmins({
      title: '宝宝相册：系统有问题',
      body: fresh.map((c) => `${c.label}：${c.message}`).join('；').slice(0, 180),
      url: '/admin/health',
    });
    log.warn({ problems: fresh.map((c) => c.key), sent }, '系统状态有问题');
    for (const c of fresh) notified[c.key] = new Date().toISOString();
  }
  settings.set('health.notified', JSON.stringify(notified));
}

export function startHealthChecks(log: FastifyBaseLogger) {
  // 刚启动时各项服务还在连接，等一会儿再查
  setTimeout(() => void runHealthChecks(log).catch((err) => log.warn({ err }, '系统检查失败')), 60_000).unref();
  setInterval(() => void runHealthChecks(log).catch((err) => log.warn({ err }, '系统检查失败')), CHECK_MS).unref();
}
