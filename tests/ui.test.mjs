// 新功能的界面测试：桌面和手机两种尺寸，对本机测试环境运行
import { BASE, CHROME, creds, SHOTS } from './env.mjs';
import puppeteer from 'puppeteer-core';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  ok ? passed++ : failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || detail === undefined ? '' : `  ${String(JSON.stringify(detail)).slice(0, 200)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--lang=zh-CN'] });
const errors = [];

async function newPage(mobile) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  if (mobile) await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36' });
  else await page.setViewport({ width: 1280, height: 860 });
  page.on('pageerror', (e) => errors.push(`${mobile ? '手机' : '桌面'} pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${mobile ? '手机' : '桌面'} console: ${m.text()}`));
  return page;
}

const clickText = async (page, selector, text) => {
  const handles = await page.$$(selector);
  for (const h of handles) if ((await h.evaluate((el) => el.textContent ?? '')).includes(text)) return h.click();
  throw new Error(`找不到 ${selector} “${text}”`);
};
const text = (page) => page.evaluate(() => document.body.innerText);
const waitText = (page, t, timeout = 15000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, t);

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[autocomplete=username]', creds.username);
  await page.type('input[autocomplete=current-password]', creds.password);
  await page.click('button.btn-primary');
  await page.waitForSelector('.baby-card');
}

// ================================================================ 桌面
{
  const page = await newPage(false);
  await login(page);
  const babyHref = await page.$eval('.baby-card', (a) => a.getAttribute('href'));
  await page.goto(`${BASE}${babyHref}`, { waitUntil: 'networkidle0' });
  const tabs = await page.$$eval('.tab-panel, .tabs .tab', (els) => els.map((e) => e.textContent?.trim()));
  check('宝宝页有 7 个标签', ['时间线', '回顾', '成长墙', '那年今日', '里程碑', '日记', '成长数据'].every((t) => tabs.includes(t)), tabs);

  // ---- 回顾
  await clickText(page, '.tabs .tab', '回顾');
  await page.waitForSelector('.review-cell, .empty', { timeout: 60000 });
  check('回顾页有精选照片', (await page.$$('.review-cell')).length > 0);
  await clickText(page, '.review-picker .chip', '出生第一年');
  await page.waitForFunction(() => document.querySelector('.section-actions h2')?.textContent?.includes('出生第一年'), { timeout: 60000 });
  check('切换到年度回顾', true);
  check('回顾选择写进网址', page.url().includes('kind=year') && page.url().includes('index=0'), page.url());
  await page.screenshot({ path: `${SHOTS}desktop-review.png` });
  await clickText(page, '.section-actions .btn-primary', '播放');
  await page.waitForSelector('.slideshow');
  check('回顾可以播放', true);
  await page.keyboard.press('Escape');

  // ---- 成长数据
  await clickText(page, '.tabs .tab', '成长数据');
  await waitText(page, '记一笔');
  check('换标签后去掉回顾参数', !page.url().includes('kind=') && page.url().includes('tab=measurements'), page.url());
  await clickText(page, '.btn-primary', '记一笔');
  await page.waitForSelector('.modal');
  const inputs = await page.$$('.modal input[inputmode=decimal]');
  await inputs[0].type('76');
  await inputs[1].type('9.8');
  await inputs[2].type('46');
  const dateInput = await page.$('.modal input[type=date]');
  const birthday = await page.evaluate(() => fetch('/api/babies').then((r) => r.json()).then((b) => b[0].birthday));
  const oneYear = `${Number(birthday.slice(0, 4)) + 1}${birthday.slice(4)}`;
  await dateInput.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, oneYear);
  await clickText(page, '.modal .btn-primary', '保存');
  await page.waitForSelector('.growth-chart svg');
  const chart = await page.$$eval('.growth-chart path', (ps) => ps.map((p) => p.getAttribute('class')));
  check('曲线图有 WHO 百分位区域和中位线', chart.includes('band-outer') && chart.includes('band-inner') && chart.includes('median'), chart);
  check('曲线图有宝宝的点', (await page.$$('.growth-chart .baby-point')).length >= 1);
  const pct = await page.$$eval('.measure-table .pct', (els) => els.map((e) => e.textContent));
  check('表格显示百分位', pct.length >= 3 && pct.every((p) => /^P\d+$|P1|P99/.test(p)), pct);
  await page.screenshot({ path: `${SHOTS}desktop-growth.png` });
  for (const [tab, label] of [
    ['身高', 'length'],
    ['头围', 'head'],
  ]) {
    await clickText(page, '.tab-panel .tabs .tab', tab);
    await sleep(200);
    check(`切换到${tab}曲线`, (await page.$$('.growth-chart .median')).length === 1, label);
  }

  // ---- 日记
  await clickText(page, '.tabs .tab', '日记');
  await waitText(page, '写日记');
  await clickText(page, '.btn-primary', '写日记');
  await page.waitForSelector('.modal textarea');
  const someDay = await page.evaluate((id) => fetch(`/api/babies/${id}/timeline?page=1&size=5`).then((r) => r.json()).then((t) => t.groups[0].items[0].takenAt.slice(0, 10)), Number(babyHref.split('/').pop()));
  await page.$eval(
    '.modal input[type=date]',
    (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    someDay,
  );
  await page.type('.modal textarea', '界面测试：今天去公园玩了');
  await clickText(page, '.modal .btn-primary', '保存');
  await page.waitForSelector('.journal-entry');
  await page.waitForSelector('.journal-photos img', { timeout: 15000 }).catch(() => {});
  check('日记显示当天的照片', (await page.$$('.journal-photos img')).length > 0);
  await page.screenshot({ path: `${SHOTS}desktop-journal.png` });

  // ---- 成长书
  await clickText(page, 'a.btn', '成长书');
  await page.waitForSelector('.book-cover');
  check('成长书有封面', (await text(page)).includes('的成长书'));
  check('成长书有月份和日记', (await page.$$('.book-month')).length > 0 && (await text(page)).includes('界面测试：今天去公园玩了'));
  await page.emulateMediaType('print');
  check('打印时隐藏顶栏和按钮', await page.$eval('.topbar', (el) => getComputedStyle(el).display === 'none'));
  await page.emulateMediaType('screen');

  // ---- 搜索
  await page.goto(`${BASE}/search`, { waitUntil: 'networkidle0' });
  await page.type('.search-box input', '蓝色');
  await page.click('.search-box button.btn-primary');
  await page.waitForSelector('.grid .thumb, .empty, .error-box', { timeout: 30000 });
  // 测试环境默认不开机器学习（模型要下载 1 GB 多），这时搜索会提示没开启，相关检查跳过
  const smartSearch = !(await text(page)).includes('语义搜索没有开启');
  if (smartSearch) {
    check('搜索有结果', (await page.$$('.grid .thumb')).length > 0, await text(page));
    check('搜索词写进网址', decodeURIComponent(page.url()).includes('q=蓝色'), page.url());
    await clickText(page, '.chip', '吃蛋糕');
    await page.waitForFunction(() => decodeURIComponent(location.search).includes('吃蛋糕'));
    await page.waitForSelector('.grid .thumb', { timeout: 30000 });
    check('点示例直接搜索', true);
    await page.screenshot({ path: `${SHOTS}desktop-search.png` });
  } else {
    check('没开语义搜索时给出提示', (await text(page)).includes('管理 → 系统设置'));
    console.log('- 没开语义搜索，跳过搜索结果的检查');
  }

  // ---- 大图：双击放大、拖动切换（从全部照片打开）
  await page.goto(`${BASE}/photos`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.grid .thumb');
  await page.evaluate(() => document.querySelector('.grid .thumb').click());
  await page.waitForSelector('.lightbox-stage img');
  const counter0 = await page.$eval('.lightbox-counter', (e) => e.textContent);
  const box = await (await page.$('.lightbox-stage')).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.click(cx, cy);
  await sleep(80);
  await page.mouse.click(cx, cy);
  await sleep(300);
  check('双击放大', await page.$eval('.lightbox-stage', (e) => e.classList.contains('zoomed')));
  await page.mouse.click(cx, cy);
  await sleep(80);
  await page.mouse.click(cx, cy);
  await sleep(300);
  check('再双击还原', !(await page.$eval('.lightbox-stage', (e) => e.classList.contains('zoomed'))));
  await sleep(400);
  await page.mouse.move(cx + 150, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy, { steps: 5 });
  await page.mouse.move(cx - 150, cy, { steps: 5 });
  await page.mouse.up();
  await sleep(300);
  const counter1 = await page.$eval('.lightbox-counter', (e) => e.textContent);
  check('向左滑切到下一张', counter0 !== counter1 && counter1.startsWith('2'), [counter0, counter1]);
  check('登录用户能看到下载按钮', !!(await page.$('a[aria-label=下载原图]')));
  await page.keyboard.press('Escape');

  // ---- 分享：密码、长辈模式、不允许下载
  await page.goto(`${BASE}/shares`, { waitUntil: 'networkidle0' });
  await clickText(page, '.btn-primary', '新建分享');
  await page.waitForSelector('.modal');
  await page.$eval('.modal input', (el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.type('.modal input', '界面测试分享');
  const toggles = await page.$$('.modal input[role=switch]');
  await toggles[0].click(); // 访问密码
  await page.waitForSelector('.modal input[autocomplete=new-password]');
  await page.type('.modal input[autocomplete=new-password]', '2468');
  await toggles[2].click(); // 长辈模式
  await clickText(page, '.modal .btn-primary', '创建');
  await page.waitForFunction(() => document.body.innerText.includes('界面测试分享'));
  const flags = await page.evaluate(() => [...document.querySelectorAll('.share-item')].find((li) => li.textContent.includes('界面测试分享')).querySelector('.share-flags').textContent);
  check('分享列表显示“有密码”“长辈模式”', flags.includes('有密码') && flags.includes('长辈模式') && !flags.includes('可下载'), flags);
  const token = await page.evaluate(() => fetch('/api/shares').then((r) => r.json()).then((s) => s.find((x) => x.label === '界面测试分享').token));

  const guest = await newPage(false);
  await guest.goto(`${BASE}/s/${token}`, { waitUntil: 'networkidle0' });
  check('打开分享先要密码', (await text(guest)).includes('请输入访问密码'));
  await guest.type('input[type=password]', '0000');
  await guest.click('button.btn-primary');
  await waitText(guest, '密码不对');
  check('密码错误有提示', true);
  await guest.$eval('input[type=password]', (el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await guest.type('input[type=password]', '2468');
  await guest.click('button.btn-primary');
  await guest.waitForSelector('.baby-header');
  check('长辈模式生效', await guest.$eval('.app', (e) => e.classList.contains('elder')));
  const fontSize = await guest.$eval('.app', (e) => getComputedStyle(e).fontSize);
  check('长辈模式字更大', fontSize === '18px', fontSize);
  await guest.waitForSelector('.grid .thumb', { timeout: 30000 });
  await guest.click('.grid .thumb');
  await guest.waitForSelector('.lightbox');
  check('不允许下载时没有下载按钮', !(await guest.$('a[aria-label=下载原图]')));
  await guest.keyboard.press('Escape');
  await guest.click('.topbar .icon-btn');
  await guest.waitForSelector('.search-box input');
  await guest.type('.search-box input', '红色');
  await guest.click('.search-box button.btn-primary');
  await guest.waitForSelector('.grid .thumb, .empty, .error-box', { timeout: 30000 });
  if (smartSearch) check('分享页可以搜索', (await guest.$$('.grid .thumb')).length > 0);
  await guest.screenshot({ path: `${SHOTS}desktop-share-elder.png` });
  await guest.reload({ waitUntil: 'networkidle0' });
  check('刷新后不用再输密码', !(await text(guest)).includes('请输入访问密码'));
  await guest.browserContext().close();
  await page.evaluate((t) => fetch('/api/shares').then((r) => r.json()).then((s) => fetch(`/api/shares/${s.find((x) => x.token === t).id}`, { method: 'DELETE' })), token);

  // ---- 管理页
  await page.goto(`${BASE}/admin/tidy`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.innerText.includes('在相册里隐藏的照片'));
  check('整理页能打开', (await text(page)).includes('疑似重复的照片'));
  await page.screenshot({ path: `${SHOTS}desktop-tidy.png`, fullPage: true });
  await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle0' });
  await waitText(page, '人脸识别与搜索');
  // 搜索模型的选项只在开了机器学习时显示
  if (smartSearch) check('设置里有搜索模型', (await text(page)).includes('多语言（推荐）'));
  else check('设置里可以打开智能功能', (await text(page)).includes('启用智能功能'));
  await page.goto(`${BASE}/admin/library`, { waitUntil: 'networkidle0' });
  check('照片库页正常', (await text(page)).includes('照片服务运行正常'));
  await page.goto(`${BASE}/account`, { waitUntil: 'networkidle0' });
  const acct = await text(page);
  check('账号页有提醒设置和退出登录', acct.includes('生日、满月回顾') && acct.includes('退出登录'), acct.slice(0, 300));
  await page.browserContext().close();
}

// ================================================================ 手机
{
  const page = await newPage(true);
  await login(page);
  const nav = await page.$eval('.topnav', (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { position: s.position, bottom: Math.round(window.innerHeight - r.bottom), labels: [...el.querySelectorAll('a')].map((a) => a.innerText.trim()) };
  });
  check('手机上导航在底部', nav.position === 'fixed' && nav.bottom === 0, nav);
  check('手机底栏显示“我的”', nav.labels.includes('我的') && nav.labels.includes('照片'), nav.labels);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('手机上没有横向滚动', overflow <= 0, overflow);
  await page.screenshot({ path: `${SHOTS}mobile-home.png` });
  const babyHref = await page.$eval('.baby-card', (a) => a.getAttribute('href'));
  await page.goto(`${BASE}${babyHref}?tab=measurements`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.growth-chart svg');
  check('手机上成长曲线能显示', (await page.$eval('.growth-chart svg', (e) => e.getBoundingClientRect().width)) > 300);
  await page.screenshot({ path: `${SHOTS}mobile-growth.png` });
  await page.goto(`${BASE}${babyHref}?tab=timeline`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.grid .thumb');
  await page.tap('.grid .thumb');
  await page.waitForSelector('.lightbox-stage img');
  // 手机上双指缩放：用 CDP 模拟两个触点
  const client = await page.createCDPSession();
  const touch = (type, pts) => client.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  await touch('touchStart', [
    [170, 420],
    [220, 420],
  ]);
  for (let i = 1; i <= 6; i++)
    await touch('touchMove', [
      [170 - i * 15, 420],
      [220 + i * 15, 420],
    ]);
  await touch('touchEnd', []);
  await sleep(300);
  const scale = await page.$eval('.lightbox-media', (e) => e.style.transform);
  check('双指张开放大', /scale\((1\.[5-9]|[2-5])/.test(scale), scale);
  // 下滑关闭（先还原）
  await page.$eval('.lightbox-media', (e) => (e.style.transform = ''));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.lightbox', { hidden: true });
  await page.tap('.grid .thumb');
  await page.waitForSelector('.lightbox-stage img');
  await sleep(300);
  await touch('touchStart', [[195, 300]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[195, 300 + i * 25]]);
  await touch('touchEnd', []);
  await sleep(300);
  check('下滑关闭大图', !(await page.$('.lightbox')));
  await page.goto(`${BASE}/account`, { waitUntil: 'networkidle0' });
  check('手机账号页有“添加到主屏幕”', (await text(page)).includes('添加到手机主屏幕'));
  await page.screenshot({ path: `${SHOTS}mobile-account.png` });
  await page.browserContext().close();
}

// ================================================================ PWA
{
  const page = await newPage(false);
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  const manifest = await page.evaluate(() => fetch('/manifest.webmanifest').then((r) => r.json()));
  check('manifest 有 192/512 PNG 和 maskable 图标', ['192x192', '512x512'].every((s) => manifest.icons.some((i) => i.sizes === s && i.type === 'image/png')) && manifest.icons.some((i) => i.purpose === 'maskable'));
  check('有 apple-touch-icon', (await page.evaluate(() => fetch(document.querySelector('link[rel=apple-touch-icon]').href).then((r) => r.headers.get('content-type')))) === 'image/png');
  await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.getRegistration().then((r) => r?.active), { timeout: 15000 }).catch(() => {});
  const sw = await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r?.active));
  check('Service Worker 已注册', sw);
  await page.browserContext().close();
}

await browser.close();
check('没有页面报错', errors.length === 0, errors);
console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
