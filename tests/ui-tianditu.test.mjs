// 天地图：真实的无效 Key 被拒绝；模拟有效 Key 时能切换、加载底图和注记两层；Key 失效时地图上有提示
import { BASE, CHROME, creds, SHOTS } from './env.mjs';
import puppeteer from 'puppeteer-core';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const GOOD = 'a'.repeat(32);
const BAD = 'b'.repeat(32);
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  ok ? passed++ : failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || detail === undefined ? '' : `  ${String(JSON.stringify(detail)).slice(0, 240)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
page.on('pageerror', (e) => errors.push(e.message));

// 模拟模式：GOOD 返回图片，其他 Key 返回天地图真实的 403 错误
let simulate = false;
const tdt = [];
await page.setRequestInterception(true);
page.on('request', (r) => {
  const url = r.url();
  if (url.includes('tianditu.gov.cn')) tdt.push(url);
  if (simulate && url.includes('tianditu.gov.cn')) {
    if (url.includes(`tk=${GOOD}`)) return r.respond({ status: 200, contentType: 'image/png', body: PNG });
    return r.respond({ status: 403, contentType: 'application/json', body: '{"msg":"非法key","code":301001}' });
  }
  r.continue();
});

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
await page.type('input[autocomplete=username]', creds.username);
await page.type('input[autocomplete=current-password]', creds.password);
await page.click('button.btn-primary');
await page.waitForSelector('.baby-card');

const settings = () => page.evaluate(() => fetch('/api/admin/app-settings').then((r) => r.json()));
const clickOption = (label) => page.evaluate((l) => [...document.querySelectorAll('.role-option')].find((b) => b.innerText.startsWith(l)).click(), label);
const setKey = (k) =>
  page.$eval(
    '.tianditu-key input',
    (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    k,
  );
const clickVerify = () => page.evaluate(() => [...document.querySelectorAll('.tianditu-key button')].find((b) => b.innerText.includes('验证')).click());

check('默认是 OpenStreetMap', (await settings()).mapTiles === 'osm');
await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.tianditu-key, .role-option');
const options = await page.evaluate(() => { const sec = [...document.querySelectorAll('.settings-section')].find((x) => x.querySelector('h3')?.textContent === '地图'); return [...sec.querySelectorAll('.role-option strong')].map((x) => x.textContent); });
check('有三个底图选项，高德保留', options.join('|') === 'OpenStreetMap（默认）|天地图|高德地图', options);
check('没 Key 时不显示 Key 输入框', !(await page.$('.tianditu-key')));
await clickOption('天地图');
await page.waitForSelector('.tianditu-key input');
check('选天地图时先要求填 Key', (await settings()).mapTiles === 'osm');

// 格式不对：服务器校验
await setKey('123');
await clickVerify();
await page.waitForSelector('.error-box');
check('Key 格式不对时提示（真实天地图拒绝或格式校验）', (await page.$eval('.error-box', (e) => e.innerText)).length > 0);

// 真实天地图：无效 Key 会被拒绝
await setKey(BAD);
await clickVerify();
await page.waitForFunction(() => document.querySelector('.error-box')?.innerText.includes('加载不了天地图'), { timeout: 20000 });
check('真实天地图拒绝无效 Key，界面提示', true);
check('无效 Key 没有保存', (await settings()).tiandituKey === null);

// 模拟有效 Key
simulate = true;
await setKey(GOOD.toUpperCase());
await clickVerify();
await page.waitForSelector('.success-box', { timeout: 15000 });
const s1 = await settings();
check('有效 Key 保存并切换到天地图', s1.mapTiles === 'tianditu' && s1.tiandituKey === GOOD, s1);
await page.screenshot({ path: `${SHOTS}tianditu-settings.png` });

// 地图加载天地图的底图和注记
tdt.length = 0;
await page.goto(`${BASE}/search?mode=map`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.map-thumb img', { timeout: 20000 });
await sleep(1000);
check('加载天地图底图（vec_w）', tdt.some((u) => u.includes('T=vec_w') && u.includes(`tk=${GOOD}`)), tdt.slice(0, 2));
check('加载天地图注记（cva_w）', tdt.some((u) => u.includes('T=cva_w')));
check('天地图不换算坐标（不请求高德）', !tdt.some((u) => u.includes('autonavi')));
check('Key 正常时没有错误提示', !(await page.$('.map-tile-error')));
const attribution = await page.$eval('.leaflet-control-attribution', (e) => e.innerText);
check('地图署名是天地图', attribution.includes('天地图'), attribution);

// Key 失效（比如超出每日限额）：地图上提示
await page.evaluate((k) => fetch('/api/admin/app-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tiandituKey: k }) }), BAD);
await page.goto(`${BASE}/search?mode=map`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.map-tile-error', { timeout: 20000 });
check('底图加载失败时地图上有提示', (await page.$eval('.map-tile-error', (e) => e.innerText)).includes('天地图的 Key'));
await page.screenshot({ path: `${SHOTS}tianditu-error.png` });

// 删除 Key 后回到 OpenStreetMap
page.on('dialog', (d) => d.accept());
await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.tianditu-key');
await page.evaluate(() => [...document.querySelectorAll('.tianditu-key button')].find((b) => b.innerText.includes('删除')).click());
await page.waitForFunction(() => document.querySelector('.success-box')?.innerText.includes('已删除'));
const s2 = await settings();
check('删除 Key 后换回 OpenStreetMap', s2.mapTiles === 'osm' && s2.tiandituKey === null, s2);

// 高德仍然可用
await clickOption('高德地图');
await sleep(500);
check('高德仍可选择', (await settings()).mapTiles === 'amap');
await page.evaluate(() => fetch('/api/admin/app-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mapTiles: 'osm' }) }));

// 接口：选天地图但没有 Key
const r = await page.evaluate(() => fetch('/api/admin/app-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mapTiles: 'tianditu' }) }).then((x) => x.status));
check('没有 Key 时不能选天地图（接口）', r === 400, r);

await browser.close();
check('没有页面报错', errors.length === 0, errors);
console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
