import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { test } from 'node:test';
import { describeConnectError, probe, serviceName } from '../src/net-check.ts';

// fetch 失败时，原因放在 cause 里（和 undici 的错误结构一致）
const fetchError = (cause: object) => Object.assign(new TypeError('fetch failed'), { cause });

test('推送服务的名字', () => {
  assert.equal(serviceName('web.push.apple.com'), '苹果推送（iPhone、iPad、Mac 上的 Safari）');
  assert.equal(serviceName('fcm.googleapis.com'), '谷歌推送（安卓手机、电脑上的 Chrome）');
  assert.equal(serviceName('push.example.com'), 'push.example.com');
});

test('失败原因翻成人话', () => {
  assert.equal(describeConnectError(fetchError({ code: 'ENOTFOUND' }), null), '域名解析不了');
  // DNS 被污染：解析到别人的服务器，证书对不上（实际遇到过的错误）
  assert.equal(
    describeConnectError(fetchError({ code: 'ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL' }), '31.13.83.34'),
    '连上的不是真正的服务器（解析到 31.13.83.34），通常是 DNS 被污染了',
  );
  assert.equal(describeConnectError(fetchError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), '1.2.3.4'), '连上的不是真正的服务器（解析到 1.2.3.4），通常是 DNS 被污染了');
  assert.equal(describeConnectError(Object.assign(new Error('timeout'), { name: 'TimeoutError' }), '1.2.3.4'), '连接超时（解析到 1.2.3.4），可能被网络屏蔽了');
  assert.equal(describeConnectError(fetchError({ code: 'UND_ERR_CONNECT_TIMEOUT' }), null), '连接超时，可能被网络屏蔽了');
  assert.equal(describeConnectError(fetchError({ code: 'ECONNRESET' }), '1.2.3.4'), '连接被中断（解析到 1.2.3.4），可能被网络屏蔽了');
  assert.equal(describeConnectError(fetchError({ code: 'ECONNREFUSED' }), '127.0.0.1'), '连接被拒绝（解析到 127.0.0.1）');
});

const listen = (server: Server | ReturnType<typeof createHttpServer>) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

test('真实连接：端口没开', async () => {
  const server = createServer();
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  const r = await probe(`https://127.0.0.1:${port}/`, 3000);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /连接被拒绝/);
});

test('真实连接：对方不回应（被屏蔽时常见）', async () => {
  const sockets: import('node:net').Socket[] = [];
  const server = createServer((s) => sockets.push(s));
  const port = await listen(server);
  const r = await probe(`https://127.0.0.1:${port}/`, 1000);
  for (const s of sockets) s.destroy();
  server.close();
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /连接超时/);
});

test('真实连接：对方不是正常的 HTTPS 服务器（和 DNS 污染一样，握手失败）', async () => {
  const server = createHttpServer((_req, res) => res.end('hello'));
  const port = await listen(server);
  const r = await probe(`https://127.0.0.1:${port}/`, 3000);
  server.close();
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /不是真正的服务器/);
});
