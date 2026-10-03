// 地图、实况标记、视频日期提示的界面测试
import { BASE, CHROME, creds, SHOTS } from './env.mjs';
import puppeteer from 'puppeteer-core';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  ok ? passed++ : failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || detail === undefined ? '' : `  ${String(JSON.stringify(detail)).slice(0, 200)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

async function newPage(mobile) {
  const page = await (await browser.createBrowserContext()).newPage();
  if (mobile) await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' });
  else await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[autocomplete=username]', creds.username);
  await page.type('input[autocomplete=current-password]', creds.password);
  await page.click('button.btn-primary');
  await page.waitForSelector('.baby-hero');
  return page;
}
const text = (page) => page.evaluate(() => document.body.innerText);

const page = await newPage(false);
const tileRequests = [];
page.on('request', (r) => /tile\.openstreetmap|autonavi/.test(r.url()) && tileRequests.push(r.url()));

// ---- 地图
await page.goto(`${BASE}/search?mode=map`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.map-canvas.leaflet-container', { timeout: 20000 });
await page.waitForSelector('.map-thumb img', { timeout: 20000 });
check('地图显示照片缩略图', (await page.$$('.map-thumb')).length > 0);
check('聚合点显示数量', (await page.$$eval('.map-thumb span', (s) => s.map((x) => x.textContent))).length > 0);
check('用的是 OpenStreetMap 底图', tileRequests.some((u) => u.includes('openstreetmap')), tileRequests.slice(0, 2));
const places = await page.$$eval('.map-places li', (ls) => ls.map((l) => l.innerText.replace(/\s+/g, ' ')));
check('地点列表（中文省份和国家）', places.length === 3 && places[0].includes('上海，中国') && places.some((p) => p.includes('日本')), places);
await page.screenshot({ path: `${SHOTS}map-desktop.png` });

// 点地点 → 下面列出这里的照片
await page.evaluate(() => [...document.querySelectorAll('.map-places button')].find((b) => b.innerText.includes('黑龙江')).click());
await page.waitForSelector('.map-selection .thumb', { timeout: 20000 });
const n = (await page.$$('.map-selection .thumb')).length;
check('点地点后列出这里的照片', n === 12, n);
check('全部范围里显示拍摄日期', (await page.$$eval('.map-selection .thumb-caption', (c) => c.map((x) => x.textContent))).every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t)));

// 点地图上的聚合点
await page.evaluate(() => document.querySelector('.leaflet-marker-icon.map-thumb').dispatchEvent(new MouseEvent('click', { bubbles: true })));
await sleep(1500);
check('点聚合点后更新照片列表', !!(await page.$('.map-selection .thumb')));
await page.evaluate(() => document.querySelector('.map-selection .thumb').click());
await page.waitForSelector('.lightbox');
check('从地图打开大图', true);
await page.keyboard.press('Escape');
// 关掉弹窗、大图时会退掉一条浏览器历史，等它退完再整页跳转，不然跳转会被打断
await sleep(300);

// 只看某个宝宝
await page.goto(`${BASE}/search?mode=map&baby=2`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.map-canvas, .empty', { timeout: 20000 });
check('只看二宝时没有带位置的照片', (await text(page)).includes('还没有带位置的照片'));

// 换高德底图
await page.evaluate(() => fetch('/api/admin/app-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mapTiles: 'amap' }) }));
tileRequests.length = 0;
await page.goto(`${BASE}/search?mode=map`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.map-thumb img', { timeout: 20000 });
await sleep(1000);
check('换成高德底图', tileRequests.some((u) => u.includes('autonavi')), tileRequests.slice(0, 2));
await page.evaluate(() => fetch('/api/admin/app-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mapTiles: 'osm' }) }));
await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle0' });
check('系统设置里有地图底图', (await text(page)).includes('高德地图'));

// ---- 实况标记（照片和视频不在同一页）
await page.goto(`${BASE}/photos`, { waitUntil: 'networkidle0' });
let liveThumb = null;
for (let i = 0; i < 6 && !liveThumb; i++) {
  liveThumb = await page.evaluateHandle(() => [...document.querySelectorAll('.thumb')].find((t) => t.getAttribute('aria-label').includes('IMG_9001')) ?? null);
  if (!(await liveThumb.jsonValue())) {
    liveThumb = null;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1500);
  }
}
check('找到实况照片', !!liveThumb);
check('缩略图有实况标记', !!liveThumb && (await liveThumb.evaluate((t) => !!t.querySelector('.thumb-live'))));
check('实况视频没有单独出现', !(await page.evaluate(() => [...document.querySelectorAll('.thumb')].some((t) => t.getAttribute('aria-label').includes('IMG_9001.MOV')))));

// 打开实况照片：自动播放的视频要和照片一样大、叠在照片上（以前被普通视频的限高缩小了一圈）
if (liveThumb) {
  await page.setViewport({ width: 1000, height: 560 });
  await liveThumb.evaluate((t) => t.click());
  await page.waitForSelector('.live-video', { timeout: 10000 }).catch(() => {});
  await sleep(300);
  const sizes = await page.evaluate(() => {
    const box = (sel) => {
      const b = document.querySelector(sel)?.getBoundingClientRect();
      return b && [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(',');
    };
    return { img: box('.lightbox-media > img'), live: box('.live-video') };
  });
  check('实况视频播放时和照片一样大', !!sizes.live && sizes.live === sizes.img, sizes);
  await page.keyboard.press('Escape');
  // 关掉弹窗、大图时会退掉一条浏览器历史，等它退完再整页跳转，不然跳转会被打断
  await sleep(300);
  await page.setViewport({ width: 1280, height: 900 });
}

// ---- 视频日期
await page.goto(`${BASE}/baby/1`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.notice', { timeout: 20000 });
const notice = await page.$eval('.notice', (e) => e.innerText);
check('日期提示包含视频', notice.includes('个视频'), notice);
await page.click('.notice');
await page.waitForSelector('.modal .thumb');
check('更正列表里有视频', !!(await page.$('.modal .thumb .thumb-badge')));
await page.screenshot({ path: `${SHOTS}date-video.png` });

// ---- 手机
const m = await newPage(true);
await m.goto(`${BASE}/search?mode=map`, { waitUntil: 'networkidle0' });
await m.waitForSelector('.map-thumb img', { timeout: 20000 });
const layout = await m.evaluate(() => ({ map: document.querySelector('.map-canvas').getBoundingClientRect().width, overflow: document.documentElement.scrollWidth - innerWidth }));
check('手机上地图占满宽度、没有横向滚动', layout.map > 340 && layout.overflow <= 0, layout);
await m.screenshot({ path: `${SHOTS}map-mobile.png` });

await browser.close();
check('没有页面报错', errors.length === 0, errors);
console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
