// 城市中文名、认识家里人、手动相册、点赞留言、提醒设置、系统状态（接口 + 界面）
import { existsSync, readFileSync } from 'node:fs';
import { BASE, CHROME, checker, creds, SHOTS } from './env.mjs';
import puppeteer from 'puppeteer-core';

const { check, done } = checker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const familyFile = new URL('../dev-data/dev-family.json', import.meta.url);
const familyIds = existsSync(familyFile) ? JSON.parse(readFileSync(familyFile, 'utf8')) : [];

class Client {
  cookies = new Map();
  async req(method, path, body, headers = {}) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data };
  }
}

const admin = new Client();
await admin.req('POST', '/api/auth/login', { username: creds.username, password: creds.password });
const babies = (await admin.req('GET', '/api/babies')).data;
const baby = babies.find((b) => b.name === '小宝') ?? babies[0];

// 可以重复运行：先把测试家人的名字清空
for (const id of familyIds) await admin.req('PUT', `/api/admin/people/${id}`, { name: '', isHidden: false });

// ================================================================ 城市中文名
const map = (await admin.req('GET', '/api/map')).data;
const placeNames = map.places.map((p) => `${p.name}|${p.region}`);
check('地点列表：上海的照片显示“黄浦”', placeNames.some((p) => p.startsWith('黄浦|上海，中国')), placeNames);
check('地点列表：哈尔滨的照片显示“松北”', placeNames.some((p) => p.startsWith('松北|黑龙江，中国')), placeNames);
check('没有中文名的地方保留原文，省和国家翻成中文', placeNames.some((p) => p.endsWith('东京都，日本')), placeNames);
const gpsAsset = map.markers.find(([, lat]) => lat > 31 && lat < 32)?.[0];
const info = (await admin.req('GET', `/api/assets/${gpsAsset}`)).data;
check('大图的地点信息是中文', info.place === '黄浦，上海，中国', info.place);

// ================================================================ 认识家里人（接口）
const unnamed = (await admin.req('GET', '/api/admin/people/unnamed')).data;
check('列出没命名、常和宝宝同框的人', unnamed.length >= 2 && unnamed.every((p) => p.withBaby > 0), unnamed);
check('和宝宝同框多的排在前面', unnamed.length < 2 || unnamed[0].withBaby >= unnamed[1].withBaby, unnamed.map((p) => p.withBaby));

// ================================================================ 界面
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--lang=zh-CN'] });
const errors = [];
async function newPage() {
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  page.on('dialog', (d) => d.accept());
  return page;
}
const text = (page) => page.evaluate(() => document.body.innerText);
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
// 要先统计每个人物和宝宝同框的次数，提示会晚一点出来
const familyHint = await page.waitForFunction(() => document.body.innerText.includes('经常和宝宝一起出现的人还没有名字'), { timeout: 20000 }).then(() => true, () => false);
check('首页提示给家人起名字', familyHint);

// ---- 认识家里人
await page.goto(`${BASE}/admin/people`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.family-card');
check('人物页显示“这几位是谁？”', (await text(page)).includes('这几位是谁？'));
await page.evaluate(() => [...document.querySelectorAll('.family-card')][0].querySelectorAll('.chip')[3].click()); // 奶奶
await page.waitForFunction(() => document.querySelector('.family-card .family-done')?.innerText.includes('奶奶'));
check('点称呼直接命名', true);
await page.evaluate(() => {
  const card = [...document.querySelectorAll('.family-card')].find((c) => !c.querySelector('.family-done'));
  const input = card.querySelector('.family-custom input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '小舅');
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await clickText(page, '.family-card:not(.done) .family-custom button', '好');
await page.waitForFunction(() => document.querySelectorAll('.family-card .family-done').length >= 2);
check('也可以输入其他称呼', true);
await page.screenshot({ path: `${SHOTS}family-intro.png` });

// ---- 和谁在一起、全家福
await page.goto(`${BASE}/baby/${baby.id}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.companions', { timeout: 20000 });
const chips = await page.$$eval('.companions .chip', (cs) => cs.map((c) => c.innerText.replace(/\s+/g, ' ')));
check('时间线上可以按家人筛选', chips.some((c) => c.includes('奶奶')) && chips.some((c) => c.includes('小舅')) && chips.some((c) => c.includes('全家福')), chips);
const companions = (await admin.req('GET', `/api/babies/${baby.id}/companions`)).data;
const nainai = companions.find((c) => c.name === '奶奶');
await clickText(page, '.companions .chip', '奶奶');
await page.waitForFunction((n) => document.querySelectorAll('.tab-panel .grid .thumb').length > 0 && document.querySelectorAll('.tab-panel .grid .thumb').length <= n, { timeout: 20000 }, nainai.count);
const filtered = await page.$$eval('.tab-panel .grid .thumb', (t) => t.length);
check('只看和奶奶的合照，数量对得上', filtered === nainai.count, { filtered, expected: nainai.count });
await clickText(page, '.companions .chip', '全家福');
await page.waitForFunction(() => document.querySelectorAll('.tab-panel .grid .thumb').length > 0 || document.body.innerText.includes('还没找到全家福'), { timeout: 30000 });
const familyCount = await page.$$eval('.tab-panel .grid .thumb', (t) => t.length);
check('全家福：宝宝和两位家人同框的照片', familyCount > 0 && familyCount < nainai.count, familyCount);
await page.screenshot({ path: `${SHOTS}family-timeline.png` });

// 分享链接看不到家人
const share0 = (await admin.req('POST', '/api/shares', { label: '测试', babyIds: [baby.id] })).data;
const anon = new Client();
const anonCompanions = await anon.req('GET', `/api/share/${share0.token}/babies/${baby.id}/companions`);
check('分享链接里不显示家人', anonCompanions.status === 200 && anonCompanions.data.length === 0, anonCompanions);
const anonFamily = await anon.req('GET', `/api/share/${share0.token}/babies/${baby.id}/timeline?with=family`);
check('分享链接不能按家人筛选', anonFamily.status === 404, anonFamily.status);
await admin.req('DELETE', `/api/shares/${share0.id}`);

// ================================================================ 手动相册
await clickText(page, '.companions .chip', '全部');
await page.waitForSelector('.select-btn');
await page.click('.select-btn');
const thumbs = await page.$$('.tab-panel .grid .thumb');
for (const t of thumbs.slice(0, 3)) await t.evaluate((e) => e.click());
check('多选：选中 3 张', (await page.$eval('.selection-bar', (e) => e.innerText)).includes('已选 3 张'));
await clickText(page, '.selection-bar button', '加入相册');
await page.waitForSelector('.album-new input');
await page.type('.album-new input', '界面测试相册');
await clickText(page, '.album-new button', '新建并加入');
await page.waitForFunction(() => document.querySelector('.modal .success-box')?.innerText.includes('已加入'));
check('新建相册并加入选中的照片', true);
await clickText(page, '.modal-footer button', '完成');
await page.waitForSelector('.selection-bar', { hidden: true });
check('加好后退出选择', true);

const albums = (await admin.req('GET', '/api/albums')).data;
const album = albums.find((a) => a.title === '界面测试相册');
check('相册里有 3 张', album?.count === 3, album);
await page.goto(`${BASE}/albums/${album.id}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.grid .thumb');
const albumItems = (await admin.req('GET', `/api/albums/${album.id}`)).data.items;
check('相册照片按拍摄时间正序', albumItems.every((it, i, a) => i === 0 || a[i - 1].takenAt <= it.takenAt));
await page.screenshot({ path: `${SHOTS}album.png` });

// 设封面：选最后一张
await clickText(page, '.selection-tools button', '选择');
await page.evaluate(() => [...document.querySelectorAll('.grid .thumb')].at(-1).click());
await clickText(page, '.selection-tools button', '设为封面');
await sleep(800);
check('设封面', (await admin.req('GET', `/api/albums/${album.id}`)).data.album.coverAssetId === albumItems.at(-1).id);

// 分享相册
await clickText(page, '.actions-row button', '分享');
await page.waitForSelector('.modal');
check('分享相册时不用选宝宝', !(await text(page)).includes('分享哪些宝宝'));
await clickText(page, '.modal-footer button', '创建');
await page.waitForFunction(() => document.querySelector('.modal input[readonly]')?.value.includes('/s/'));
const shareUrl = await page.$eval('.modal input[readonly]', (e) => e.value);
check('分享相册直接给出链接', shareUrl.includes('/s/'), shareUrl);
const token = shareUrl.split('/s/')[1];

// ================================================================ 访客：看相册、点赞、留言
const guestPage = await newPage();
await guestPage.goto(`${BASE}/s/${token}`, { waitUntil: 'networkidle0' });
await guestPage.waitForSelector('.grid .thumb');
check('访客看到相册标题和照片', (await text(guestPage)).includes('界面测试相册') && (await guestPage.$$('.grid .thumb')).length === 3);
const guest = new Client();
const outside = (await admin.req('GET', `/api/babies/${baby.id}/timeline?page=1&size=50`)).data.groups.flatMap((g) => g.items).find((i) => !albumItems.some((a) => a.id === i.id));
check('访客看不到相册以外的照片', (await guest.req('GET', `/api/share/${token}/assets/${outside.id}/thumbnail`)).status === 404);
check('访客看不到宝宝的时间线', (await guest.req('GET', `/api/share/${token}/babies/${baby.id}/timeline`)).status === 404);

await guestPage.evaluate(() => document.querySelector('.grid .thumb').click());
await guestPage.waitForSelector('.lightbox');
await guestPage.click('button[aria-label=点赞留言]');
await guestPage.waitForSelector('.social-name input');
const defaultName = await guestPage.$eval('.social-name input', (e) => e.value);
check('第一次互动先问称呼，默认是分享的对象', defaultName === '家里人', defaultName);
await guestPage.$eval('.social-name input', (el) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '奶奶');
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await guestPage.click('.like-btn');
await guestPage.waitForFunction(() => document.querySelector('.like-btn')?.innerText.includes('已赞'));
check('访客点赞', (await text(guestPage)).includes('奶奶 觉得很赞'));
await guestPage.type('.comment-form input', '真可爱！');
await guestPage.click('.comment-form button');
await guestPage.waitForFunction(() => document.querySelector('.comments')?.innerText.includes('真可爱！'));
check('访客留言', true);
await guestPage.screenshot({ path: `${SHOTS}guest-social.png` });
// 刷新后还记得称呼和自己的留言
await guestPage.reload({ waitUntil: 'networkidle0' });
await guestPage.evaluate(() => document.querySelector('.grid .thumb').click());
await guestPage.waitForSelector('button[aria-label=点赞留言] .count');
await guestPage.click('button[aria-label=点赞留言]');
await guestPage.waitForSelector('.comments');
check('刷新后不再问称呼', !(await guestPage.$('.social-name input')));
check('刷新后还能删除自己的留言', !!(await guestPage.$('.comments button[aria-label=删除留言]')));

// 家里人看到互动
const firstId = albumItems[0].id;
const recent = (await admin.req('GET', '/api/social/recent')).data;
check('首页“家人的点赞和留言”里有访客的留言', recent.some((r) => r.kind === 'comment' && r.name === '奶奶' && r.text === '真可爱！' && r.assetId === firstId), recent.slice(0, 3));
await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.recent-social', { timeout: 10000 });
check('首页显示家人的留言', (await text(page)).includes('真可爱！'));
await page.evaluate(() => document.querySelector('.recent-social a').click());
await page.waitForSelector('.lightbox .social', { timeout: 10000 });
check('点留言打开那张照片和留言', (await page.$eval('.lightbox .social', (e) => e.innerText)).includes('真可爱！'));

// 登录的家人留言、删除访客的留言；访客不能删别人的
let social = (await admin.req('POST', `/api/assets/${firstId}/comments`, { text: '谢谢奶奶' })).data;
const mine = social.comments.find((c) => c.text === '谢谢奶奶');
check('登录的家人用自己的称呼留言', mine?.name === creds.displayName && mine.mine, mine);
const guestDel = await guest.req('DELETE', `/api/share/${token}/comments/${mine.id}`);
check('访客不能删别人的留言', guestDel.status === 403 || guestDel.status === 404, guestDel.status);
const guestComment = social.comments.find((c) => c.text === '真可爱！');
check('家里人可以删访客的留言', (await admin.req('DELETE', `/api/comments/${guestComment.id}`)).status === 204);

// 关掉点赞留言
const shares = (await admin.req('GET', '/api/shares')).data;
const albumShare = shares.find((s) => s.token === token);
await admin.req('PUT', `/api/shares/${albumShare.id}`, { label: albumShare.label, albumId: album.id, allowComments: false });
check('关掉后访客不能点赞', (await guest.req('POST', `/api/share/${token}/assets/${firstId}/like`, {})).status === 403);
check('关掉后访客看不到互动', (await guest.req('GET', `/api/share/${token}/assets/${firstId}/social`)).status === 404);

// 删除相册后分享失效
await admin.req('DELETE', `/api/albums/${album.id}`);
check('删除相册后分享链接失效', (await guest.req('GET', `/api/share/${token}`)).status === 404);

// ================================================================ 提醒设置、每周小结
const prefs = (await admin.req('GET', '/api/push/prefs')).data;
check('提醒默认全部打开', prefs.milestones && prefs.weekly && prefs.family && prefs.system, prefs);
check('可以单独关掉每周小结', (await admin.req('PUT', '/api/push/prefs', { weekly: false })).data.weekly === false);
await admin.req('PUT', '/api/push/prefs', { weekly: true });
const weekly = (await admin.req('GET', '/api/push/weekly-preview')).data;
check('每周小结的内容', weekly.title === '这周的照片' && typeof weekly.body === 'string', weekly);
await page.goto(`${BASE}/account`, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.querySelector('.notify-prefs'), { timeout: 10000 });
const accountText = await text(page);
check('账号页有提醒的分类开关', ['生日、满月回顾', '每周小结', '家人的点赞、留言', '系统提醒'].every((t) => accountText.includes(t)), accountText.slice(0, 400));

// ================================================================ 系统状态
const health = (await admin.req('POST', '/api/admin/health/check')).data;
const byKey = Object.fromEntries(health.checks.map((c) => [c.key, c]));
check('系统状态检查了 9 项', health.checks.length === 9, health.checks.map((c) => c.key));
check('照片服务正常', byKey.immich.status === 'ok', byKey.immich);
check('存储正常', byKey.storage.status === 'ok' || byKey.storage.status === 'skip', byKey.storage);
check('没通过 HTTPS 访问过时不检查证书', byKey.cert.status === 'skip', byKey.cert);
// 实际连推送服务：测试环境能上网时应该都连得上；连不上时要说清楚是哪个服务、什么原因
check(
  '网络连接：实际连推送服务',
  byKey.network && (byKey.network.status === 'ok' ? byKey.network.message.includes('苹果推送') : /推送.*：/.test(byKey.network.message)),
  byKey.network,
);
await page.goto(`${BASE}/admin/health`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.health-row');
check('系统状态页显示每一项', (await page.$$('.health-row')).length === 9);
await page.screenshot({ path: `${SHOTS}health.png`, fullPage: true });

await browser.close();
// 收尾：家人名字清空，下次还能测
for (const id of familyIds) await admin.req('PUT', `/api/admin/people/${id}`, { name: '' });
check('没有页面报错', errors.length === 0, errors);
done();
