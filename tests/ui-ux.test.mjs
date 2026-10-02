// 使用细节：返回键关大图和弹窗、页面里的确认框、时间显示、时间线跳转、认人看照片、分享页出错提示
import puppeteer from 'puppeteer-core';
import { BASE, CHROME, checker, creds, SHOTS } from './env.mjs';

const { check, done } = checker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  cookies = new Map();
  async req(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const text = await res.text();
    try {
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      return { status: res.status, data: text };
    }
  }
}

const admin = new Client();
await admin.req('POST', '/api/auth/login', { username: creds.username, password: creds.password });
const babies = (await admin.req('GET', '/api/babies')).data;
const baby = babies.find((b) => b.name === '小宝') ?? babies[0];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--lang=zh-CN'] });
const errors = [];
async function newPage() {
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 1280, height: 900 });
  // 时间按北京时间显示
  await page.emulateTimezone('Asia/Shanghai');
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  // 不应该再弹浏览器自带的确认框
  page.on('dialog', (d) => {
    errors.push(`浏览器弹框：${d.message()}`);
    d.dismiss();
  });
  return page;
}
const text = (page) => page.evaluate(() => document.body.innerText);
const path = (page) => new URL(page.url()).pathname + new URL(page.url()).search;
const clickText = (page, selector, t) =>
  page.evaluate(
    (sel, t) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.innerText.includes(t));
      if (!el) throw new Error(`找不到 ${sel} “${t}”`);
      el.click();
    },
    selector,
    t,
  );

const page = await newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
await page.type('input[autocomplete=username]', creds.username);
await page.type('input[autocomplete=current-password]', creds.password);
await page.click('button.btn-primary');
await page.waitForSelector('.baby-card');

// ================================================================ 返回键：关掉大图，不离开页面
await page.click(`a.baby-card[href="/baby/${baby.id}"]`);
await page.waitForSelector('.tab-panel .grid .thumb', { timeout: 30000 });
const babyPath = path(page);
await page.evaluate(() => document.querySelector('.tab-panel .grid .thumb').click());
await page.waitForSelector('.lightbox');
await page.goBack();
await page.waitForSelector('.lightbox', { hidden: true, timeout: 5000 }).catch(() => {});
check('打开大图后按返回键：关掉大图', !(await page.$('.lightbox')));
check('……而且还在宝宝页', path(page) === babyPath, path(page));

// 点关闭按钮关掉大图后，再按返回键是回到上一页（首页），不用多按一次
await page.evaluate(() => document.querySelector('.tab-panel .grid .thumb').click());
await page.waitForSelector('.lightbox');
await page.click('.lightbox-bar button[aria-label=关闭]');
await sleep(300);
await page.goBack();
await sleep(500);
check('点关闭后按返回键回到首页', path(page) === '/', path(page));

// 刷新页面后（浏览器历史里还留着刷新前的弹窗记录），返回键照样能关掉新打开的大图
await page.goto(`${BASE}/baby/${baby.id}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.tab-panel .grid .thumb', { timeout: 30000 });
await page.evaluate(() => document.querySelector('.tab-panel .grid .thumb').click());
await page.waitForSelector('.lightbox');
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.tab-panel .grid .thumb', { timeout: 30000 });
await page.evaluate(() => document.querySelector('.tab-panel .grid .thumb').click());
await page.waitForSelector('.lightbox');
await page.goBack();
await sleep(500);
check('刷新页面后：返回键照样能关掉大图', !(await page.$('.lightbox')) && path(page).startsWith(`/baby/${baby.id}`), path(page));

// ================================================================ 时间线：跳到某个月龄、切换标签保留位置
await page.goto(`${BASE}/baby/${baby.id}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.tab-panel .grid .thumb', { timeout: 30000 });
const firstGroup = await page.$eval('.group-header h3', (e) => e.innerText);
await clickText(page, '.timeline-buttons button', '跳到');
await page.waitForSelector('.jump-cell', { timeout: 30000 });
// 返回键关掉弹窗
await page.goBack();
await page.waitForSelector('.modal', { hidden: true, timeout: 5000 }).catch(() => {});
check('弹窗打开时按返回键：只关弹窗', !(await page.$('.modal')) && path(page).startsWith(`/baby/${baby.id}`), path(page));
await clickText(page, '.timeline-buttons button', '跳到');
await page.waitForSelector('.jump-cell');
// 选一个有照片、但不是最新的月龄
const target = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('.jump-cell')].filter((c) => !c.disabled).slice(1);
  const cell = cells[Math.floor(cells.length / 2)];
  if (!cell) return null;
  cell.click();
  return cell.innerText.trim();
});
if (target) {
  await page.waitForSelector('.jump-banner', { timeout: 10000 });
  await page.waitForSelector('.tab-panel .grid .thumb', { timeout: 30000 });
  const group = await page.$eval('.group-header h3', (e) => e.innerText);
  check('跳到某个月龄：时间线从那个月龄开始', group !== firstGroup && (await page.$eval('.jump-banner', (e) => e.innerText)).includes(target), { target, group, firstGroup });
  // 跳完停在时间线开头：工具栏在吸顶的标签栏下面露出来，关弹窗时浏览器也没把位置恢复回去
  await sleep(500);
  const toolsTop = await page.$eval('.timeline-tools', (e) => e.getBoundingClientRect().top);
  const tabsBottom = await page.$eval('.tabs', (e) => e.getBoundingClientRect().bottom);
  check('跳转后停在时间线开头，没被吸顶栏挡住', toolsTop >= tabsBottom - 1 && toolsTop < 400, { toolsTop, tabsBottom });
  await page.screenshot({ path: `${SHOTS}timeline-jump.png` });
  await clickText(page, '.jump-banner button', '回到最新');
  await page.waitForFunction((g) => document.querySelector('.group-header h3')?.innerText === g, { timeout: 20000 }, firstGroup);
  check('回到最新', !(await page.$('.jump-banner')));
} else console.log('- 测试照片只有一个月龄，跳过跳转检查');

const tall = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 600);
if (tall) {
  await page.evaluate(() => window.scrollTo(0, 500));
  await sleep(200);
  await clickText(page, '.tabs .tab', '回顾');
  await sleep(500);
  await clickText(page, '.tabs .tab', '照片');
  await sleep(300);
  const y = await page.evaluate(() => window.scrollY);
  check('切到“回顾”再切回来：时间线还在原来的位置', Math.abs(y - 500) < 5, y);
} else console.log('- 时间线太短，跳过滚动位置检查');

// ================================================================ 编辑弹窗里删除（确认框和编辑弹窗一起关掉）：历史记录里不留下多余的
const milestone = (await admin.req('POST', `/api/babies/${baby.id}/milestones`, { title: '历史记录测试', date: baby.birthday })).data;
await page.goto(`${BASE}/baby/${baby.id}?tab=records&view=milestones`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.milestone');
const historyBefore = await page.evaluate(() => history.length);
await page.evaluate(() => [...document.querySelectorAll('.milestone')].find((m) => m.innerText.includes('历史记录测试')).querySelector('button[aria-label=编辑]').click());
await page.waitForSelector('.modal');
await clickText(page, '.modal-footer button', '删除');
await page.waitForSelector('.modal .btn-danger');
await page.click('.modal .btn-danger');
await page.waitForSelector('.modal', { hidden: true, timeout: 10000 });
await sleep(500);
const after = await page.evaluate(() => ({ layer: history.state?.babyAlbumLayer ?? 0, length: history.length }));
check('删除里程碑后，历史记录退回到打开弹窗前', after.layer === 0, after);
check('……而且删掉了', !(await admin.req('GET', `/api/babies/${baby.id}/milestones`)).data.some((m) => m.id === milestone.id));
// 再按一次返回键就离开宝宝页（不会有一次“按了没反应”）
const beforeBack = path(page);
await page.goBack();
await sleep(500);
check('之后按返回键直接回到上一页', path(page) !== beforeBack, { beforeBack, now: path(page), historyBefore });

// ================================================================ 留言：时间按本地时间显示；从留言页点进照片，关掉回到留言页
const assetId = await page.evaluate(() => {
  const img = document.querySelector('.tab-panel .grid .thumb img');
  return img?.getAttribute('src')?.match(/assets\/([^/]+)\//)?.[1];
});
const comment = await admin.req('POST', `/api/assets/${assetId}/comments`, { text: '时间测试' });
const created = comment.data.comments.find((c) => c.text === '时间测试');
// 服务器存的是 UTC，北京时间要加 8 小时
const utc = new Date(`${created.createdAt.replace(' ', 'T')}Z`);
const local = new Date(utc.getTime() + 8 * 3600_000);
const expected = `${local.getUTCHours().toString().padStart(2, '0')}:${local.getUTCMinutes().toString().padStart(2, '0')}`;
await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.message-list li');
const firstMessage = await page.$eval('.message-list li', (e) => e.innerText);
check('留言时间按北京时间显示（不是 UTC）', firstMessage.includes(expected), { firstMessage, expected, stored: created.createdAt });
await page.click('.message-list li a');
await page.waitForSelector('.lightbox');
await page.click('.lightbox-bar button[aria-label=关闭]');
await page.waitForSelector('.message-list', { timeout: 5000 }).catch(() => {});
check('从留言页点进照片，关掉回到留言页', path(page) === '/messages', path(page));

// ================================================================ 页面里的确认框：删除留言
await page.click('.message-list li a');
await page.waitForSelector('.lightbox .comments');
const before = await page.$$eval('.lightbox .comments li', (l) => l.length);
await page.evaluate(() => [...document.querySelectorAll('.lightbox .comments li')].find((li) => li.innerText.includes('时间测试')).querySelector('button[aria-label=删除留言]').click());
await page.waitForSelector('.modal .btn-danger');
check('删除前用页面里的确认框', (await page.$eval('.modal', (e) => e.innerText)).includes('删除这条留言'));
// Esc 只关确认框，不关大图
await page.keyboard.press('Escape');
await sleep(200);
check('确认框里按 Esc 只关确认框', !(await page.$('.modal')) && !!(await page.$('.lightbox')));
await page.evaluate(() => [...document.querySelectorAll('.lightbox .comments li')].find((li) => li.innerText.includes('时间测试')).querySelector('button[aria-label=删除留言]').click());
await page.waitForSelector('.modal .btn-danger');
await page.click('.modal .btn-danger');
// 关掉弹窗、大图时会退掉一条浏览器历史，等它退完再整页跳转，不然跳转会被打断
await sleep(300);
await page.waitForFunction((n) => document.querySelectorAll('.lightbox .comments li').length < n, { timeout: 10000 }, before).catch(() => {});
check('确认后删掉了', (await page.$$eval('.lightbox .comments li', (l) => l.length)) === before - 1);

// ================================================================ 认人：人物弹窗里看照片，点开大图，返回键只关大图
await page.goto(`${BASE}/admin/people`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.person-card');
await page.click('.person-card');
await page.waitForSelector('.modal .face-crop', { timeout: 20000 });
check('人物弹窗里显示 TA 的照片', (await page.$$('.modal .face-crop')).length > 0);
await page.click('.modal .face-crop');
await page.waitForSelector('.lightbox');
await page.goBack();
await sleep(300);
check('人物弹窗里看大图，按返回键只关大图', !(await page.$('.lightbox')) && !!(await page.$('.modal')));
await page.goBack();
await sleep(300);
check('再按返回键关掉人物弹窗', !(await page.$('.modal')) && path(page) === '/admin/people', path(page));

// “这几位是谁”：看照片、点错了可以撤销
const card = await page.$('.family-card');
if (card) {
  await page.evaluate(() => [...document.querySelector('.family-card').querySelectorAll('button')].find((b) => b.innerText.includes('看照片')).click());
  await page.waitForSelector('.modal .face-crop', { timeout: 20000 });
  check('“这几位是谁”可以看照片', true);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { hidden: true });
  const personId = await page.$eval('.family-card img', (img) => img.getAttribute('src').match(/people\/([^/]+)\//)[1]);
  await page.evaluate(() => document.querySelector('.family-card .chip').click());
  await page.waitForSelector('.family-card .family-done');
  await clickText(page, '.family-card button', '撤销');
  await page.waitForFunction(() => !document.querySelector('.family-card .family-done'), { timeout: 10000 }).catch(() => {});
  const person = (await admin.req('GET', '/api/admin/people?hidden=true')).data.find((p) => p.id === personId);
  check('命名后可以撤销', !(await page.$('.family-card .family-done')) && person?.name === '', person?.name);
} else console.log('- 没有“这几位是谁”的卡片，跳过');

// ================================================================ 分享页：服务器出错时不说“链接无效”
const share = (await admin.req('POST', '/api/shares', { label: '出错测试', babyIds: [baby.id] })).data;
const guest = await newPage();
await guest.setRequestInterception(true);
guest.on('request', (r) => (r.url().endsWith(`/api/share/${share.token}`) ? r.respond({ status: 502, body: 'Bad Gateway' }) : r.continue()));
await guest.goto(`${BASE}/s/${share.token}`, { waitUntil: 'networkidle0' });
await guest.waitForSelector('.empty', { timeout: 20000 });
const guestText = await text(guest);
check('分享页连不上时提示稍后再试，不说链接无效', guestText.includes('暂时打不开') && !guestText.includes('链接无效'), guestText.slice(0, 200));
await guest.goto(`${BASE}/s/not-a-real-token`, { waitUntil: 'networkidle0' });
await guest.waitForSelector('.empty', { timeout: 20000 });
check('链接确实不存在时才说无效', (await text(guest)).includes('链接无效'));

// ================================================================ 停用分享链接：页面里的确认框
await page.goto(`${BASE}/shares`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.share-item');
await page.evaluate((label) => [...document.querySelectorAll('.share-item')].find((li) => li.innerText.includes(label)).querySelector('button[aria-label=停用]').click(), '出错测试');
await page.waitForSelector('.modal .btn-danger');
await page.click('.modal .btn-danger');
await page.waitForSelector('.modal', { hidden: true, timeout: 10000 });
check('停用分享链接', (await admin.req('GET', `/api/share/${share.token}`)).status === 404);

// ================================================================ 手机：输入框不小于 16px（iPhone 上才不会自动放大）
const phone = await newPage();
await phone.emulate({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
await phone.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
const coarse = await phone.evaluate(() => matchMedia('(pointer: coarse)').matches);
if (coarse) {
  const size = await phone.$eval('input[autocomplete=username]', (e) => parseFloat(getComputedStyle(e).fontSize));
  check('手机上输入框字号不小于 16px', size >= 16, size);
} else console.log('- 浏览器没有模拟触屏，跳过输入框字号检查');

await browser.close();
check('没有页面报错，也没有浏览器自带的确认框', errors.length === 0, errors);
done();
