// 网络连通性探测：真正发一个 HTTPS 请求，看能不能连上真正的服务器。
// 只看“能不能解析出地址”不够：在国内，被屏蔽的域名会解析出假地址（DNS 污染），
// 解析“成功”了却连不上，或者连上的不是真正的服务器（证书对不上）

import { lookup } from 'node:dns/promises';

export type ProbeResult = { ok: true; ms: number; address: string | null } | { ok: false; reason: string; address: string | null };

/** 推送服务的地址 → 给人看的名字 */
const KNOWN_SERVICES: [RegExp, string][] = [
  [/(^|\.)push\.apple\.com$/, '苹果推送（iPhone、iPad、Mac 上的 Safari）'],
  [/(^|\.)fcm\.googleapis\.com$|(^|\.)android\.googleapis\.com$/, '谷歌推送（安卓手机、电脑上的 Chrome）'],
  [/(^|\.)push\.services\.mozilla\.com$/, '火狐推送（Firefox）'],
  [/(^|\.)notify\.windows\.com$/, '微软推送（电脑上的 Edge）'],
];

export function serviceName(host: string) {
  return KNOWN_SERVICES.find(([re]) => re.test(host))?.[1] ?? host;
}

const TLS_ERROR = /^(ERR_SSL_|ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;

/** 把连接失败的错误翻成人话。address：域名解析出的地址（有的话写进提示里） */
export function describeConnectError(err: unknown, address: string | null): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string; message?: string } };
  const code = e.cause?.code ?? e.code ?? '';
  const name = e.cause?.name ?? e.name ?? '';
  const at = address ? `（解析到 ${address}）` : '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') return '域名解析不了';
  if (TLS_ERROR.test(code)) return `连上的不是真正的服务器${at}，通常是 DNS 被污染了`;
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return `连接超时${at}，可能被网络屏蔽了`;
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return `连接被中断${at}，可能被网络屏蔽了`;
  if (code === 'ECONNREFUSED') return `连接被拒绝${at}`;
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return '网络不通';
  return `连不上：${e.cause?.message ?? code ?? name ?? '未知原因'}`;
}

/** 访问一下这个地址：只要服务器给了响应（不管状态码）、证书是对的，就算连得上 */
export async function probe(url: string, timeoutMs = 8000): Promise<ProbeResult> {
  const host = new URL(url).hostname;
  const address = await lookup(host).then(
    (r) => r.address,
    () => null,
  );
  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return { ok: true, ms: Date.now() - started, address };
  } catch (err) {
    return { ok: false, reason: describeConnectError(err, address), address };
  }
}
