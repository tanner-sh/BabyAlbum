// 新功能的接口测试：对本机测试环境（http://localhost:3000）运行
import { BASE, creds } from './env.mjs';


let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ${JSON.stringify(detail)?.slice(0, 300)}`}`);
}

class Client {
  cookies = new Map<string, string>();
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, headers: res.headers };
  }
}

const admin = new Client();
const login = await admin.req('POST', '/api/auth/login', { username: creds.username, password: creds.password });
check('管理员登录', login.status === 200, login);

// ---------------------------------------------------------------- 宝宝性别
const babies = (await admin.req('GET', '/api/babies')).data;
const baby = babies[0];
check('宝宝列表带 sex 字段', baby && 'sex' in baby, baby);
let r = await admin.req('PATCH', `/api/babies/${baby.id}`, { sex: 'boy' });
check('设置性别', r.status === 200 && r.data.sex === 'boy', r);
r = await admin.req('PATCH', `/api/babies/${baby.id}`, { sex: 'x' });
check('性别取值校验', r.status === 400, r);

// ---------------------------------------------------------------- 成长数据
r = await admin.req('POST', `/api/babies/${baby.id}/measurements`, { date: baby.birthday });
check('成长数据至少填一项', r.status === 400, r);
r = await admin.req('POST', `/api/babies/${baby.id}/measurements`, { date: baby.birthday, heightCm: 50.2, weightKg: 3.4, headCm: 34.5, note: '出生' });
check('新增成长数据', r.status === 201 && r.data.ageDays === 0 && r.data.ageLabel === '出生当天', r);
const m1 = r.data;
r = await admin.req('PUT', `/api/measurements/${m1.id}`, { date: baby.birthday, heightCm: 50.5, weightKg: null, headCm: null, note: '' });
check('修改成长数据', r.status === 200 && r.data.heightCm === 50.5 && r.data.weightKg === null, r);
r = await admin.req('GET', `/api/babies/${baby.id}/measurements`);
check('读取成长数据', r.status === 200 && r.data.some((x: any) => x.id === m1.id), r);
r = await admin.req('POST', `/api/babies/${baby.id}/measurements`, { date: baby.birthday, weightKg: 500 });
check('体重范围校验', r.status === 400, r);

// ---------------------------------------------------------------- 日记
const timeline = (await admin.req('GET', `/api/babies/${baby.id}/timeline?page=1&size=50`)).data;
const someItem = timeline.groups[0].items[0];
const someDate = someItem.takenAt.slice(0, 10);
r = await admin.req('POST', `/api/babies/${baby.id}/journal`, { date: someDate, text: '  ' });
check('日记不能为空', r.status === 400, r);
r = await admin.req('POST', `/api/babies/${baby.id}/journal`, { date: someDate, text: '今天第一次翻身！\n很开心' });
check('写日记', r.status === 201 && r.data.authorName === creds.displayName && !!r.data.ageLabel, r);
const j1 = r.data;
r = await admin.req('PUT', `/api/journal/${j1.id}`, { date: someDate, text: '改过的日记' });
check('修改日记', r.status === 200 && r.data.text === '改过的日记', r);
r = await admin.req('GET', `/api/babies/${baby.id}/days/${someDate}`);
check('某一天的照片', r.status === 200 && r.data.some((i: any) => i.id === someItem.id) && r.data.every((i: any) => i.takenAt.startsWith(someDate)), r.data?.length);
check('照片带 livePhotoVideoId 字段', 'livePhotoVideoId' in someItem, someItem);

// ---------------------------------------------------------------- 回顾
r = await admin.req('GET', `/api/babies/${baby.id}/review?kind=year&index=0`);
check('年度回顾', r.status === 200 && r.data.items.length > 0 && r.data.items.length <= 36 && r.data.total >= r.data.items.length, { status: r.status, n: r.data.items?.length, total: r.data.total });
const sortedAsc = r.data.items.every((it: any, i: number, a: any[]) => i === 0 || a[i - 1].takenAt <= it.takenAt);
check('回顾按时间正序', sortedAsc);
check('回顾只挑照片不挑视频', r.data.items.every((i: any) => i.type === 'IMAGE'));
check('回顾在范围内', r.data.items.every((i: any) => i.takenAt.slice(0, 10) >= r.data.from && i.takenAt.slice(0, 10) < r.data.to), r.data);
r = await admin.req('GET', `/api/babies/${baby.id}/review?kind=month&index=2`);
check('月度回顾', r.status === 200 && r.data.items.length <= 12 && r.data.label, { status: r.status, n: r.data.items?.length, label: r.data.label });
r = await admin.req('GET', `/api/babies/${baby.id}/review?kind=week&index=0`);
check('回顾参数校验', r.status === 400, r);

// ---------------------------------------------------------------- 在相册里隐藏
r = await admin.req('POST', '/api/admin/hidden', { assetIds: [someItem.id], reason: '测试' });
check('隐藏照片', r.status === 200, r);
let tl = (await admin.req('GET', `/api/babies/${baby.id}/timeline?page=1&size=50`)).data;
check('隐藏后时间线里没有', !tl.groups.flatMap((g: any) => g.items).some((i: any) => i.id === someItem.id));
r = await admin.req('GET', '/api/admin/hidden');
check('隐藏列表', r.status === 200 && r.data.some((h: any) => h.assetId === someItem.id && h.fileName), r);
r = await admin.req('DELETE', `/api/admin/hidden/${someItem.id}`);
check('恢复显示', r.status === 204, r);
tl = (await admin.req('GET', `/api/babies/${baby.id}/timeline?page=1&size=50`)).data;
check('恢复后时间线里又有了', tl.groups.flatMap((g: any) => g.items).some((i: any) => i.id === someItem.id));

// ---------------------------------------------------------------- 实况
r = await admin.req('GET', `/api/assets/${someItem.id}/live`);
check('非实况照片的 live 返回 404', r.status === 404, r.status);

// ---------------------------------------------------------------- 分享增强
r = await admin.req('POST', '/api/shares', { label: '测试长辈', babyIds: [baby.id], password: '1234', allowDownload: false, elderMode: true });
check('新建带密码的分享', r.status === 201 && r.data.hasPassword && !('passwordHash' in r.data) && r.data.elderMode && !r.data.allowDownload, r);
const share = r.data;
const guest = new Client();
r = await guest.req('GET', `/api/share/${share.token}`);
check('没输密码只返回 needsPassword，不透露宝宝', r.status === 200 && r.data.needsPassword === true && !r.data.babies, r);
r = await guest.req('GET', `/api/share/${share.token}/babies/${baby.id}/timeline`);
check('没输密码不能看时间线', r.status === 401, r.status);
r = await guest.req('GET', `/api/share/${share.token}/assets/${someItem.id}/thumbnail`);
check('没输密码不能看缩略图', r.status === 401, r.status);
r = await guest.req('POST', `/api/share/${share.token}/unlock`, { password: 'wrong' });
check('密码错误', r.status === 401, r);
r = await guest.req('POST', `/api/share/${share.token}/unlock`, { password: '1234' });
check('密码正确', r.status === 200 && guest.cookies.has(`share_${share.id}`), r);
r = await guest.req('GET', `/api/share/${share.token}`);
check('输对密码后能看', r.status === 200 && r.data.needsPassword === false && r.data.elderMode === true && r.data.babies.length === 1, r);
r = await guest.req('GET', `/api/share/${share.token}/babies/${baby.id}/timeline`);
check('输对密码后能看时间线', r.status === 200, r.status);
r = await guest.req('GET', `/api/share/${share.token}/assets/${someItem.id}/original`);
check('不允许下载原图', r.status === 403, r.status);
r = await guest.req('GET', `/api/share/${share.token}/babies/${baby.id}/measurements`);
check('分享能看成长数据', r.status === 200 && r.data.some((x: any) => x.id === m1.id), r);
r = await guest.req('GET', `/api/share/${share.token}/babies/${baby.id}/journal`);
check('分享能看日记', r.status === 200 && r.data.some((x: any) => x.id === j1.id), r);
r = await guest.req('POST', `/api/babies/${baby.id}/journal`, { date: someDate, text: 'x' });
check('分享访客不能写日记', r.status === 401, r.status);
// 改密码后旧 Cookie 失效
r = await admin.req('PUT', `/api/shares/${share.id}`, { label: '测试长辈', babyIds: [baby.id], password: '5678', allowDownload: true, elderMode: false });
check('修改分享', r.status === 200 && r.data.allowDownload && !r.data.elderMode && r.data.hasPassword, r);
r = await guest.req('GET', `/api/share/${share.token}/babies/${baby.id}/timeline`);
check('改密码后要重新输入', r.status === 401, r.status);
await guest.req('POST', `/api/share/${share.token}/unlock`, { password: '5678' });
r = await guest.req('GET', `/api/share/${share.token}/assets/${someItem.id}/original`);
check('允许下载后能下载原图', r.status === 200, r.status);
r = await admin.req('PUT', `/api/shares/${share.id}`, { label: '测试长辈', babyIds: [baby.id], password: null });
check('去掉密码', r.status === 200 && !r.data.hasPassword, r);
const guest2 = new Client();
r = await guest2.req('GET', `/api/share/${share.token}`);
check('去掉密码后直接能看', r.status === 200 && r.data.needsPassword === false, r);
r = await admin.req('PUT', `/api/shares/${share.id}`, { label: '测试长辈', babyIds: [baby.id], password: '12' });
check('密码长度校验', r.status === 400, r);
// 另一个宝宝的照片，分享里不能访问
const other = babies.find((b: any) => b.id !== baby.id);
if (other) {
  const otherTl = (await admin.req('GET', `/api/babies/${other.id}/timeline?page=1&size=200`)).data;
  const onlyOther = otherTl.groups.flatMap((g: any) => g.items).find(async () => true);
  r = await guest2.req('GET', `/api/share/${share.token}/babies/${other.id}/timeline`);
  check('分享不能看别的宝宝', r.status === 404, r.status);
  void onlyOther;
}
await admin.req('DELETE', `/api/shares/${share.id}`);

// ---------------------------------------------------------------- 搜索
r = await admin.req('GET', `/api/search?q=${encodeURIComponent('在海边')}`);
check('搜索接口可用（机器学习没开时返回明确的错误）', r.status === 200 || r.status === 409, r);
console.log('   搜索返回：', r.status, JSON.stringify(r.data).slice(0, 160));
r = await admin.req('GET', `/api/search?q=`);
check('搜索词不能为空', r.status === 400, r.status);

// ---------------------------------------------------------------- 管理：导入进度、人物、重复
r = await admin.req('GET', '/api/admin/import-progress');
check('导入进度', r.status === 200 && Array.isArray(r.data.stages) && r.data.stages.length === 8, r);
r = await admin.req('GET', '/api/admin/people/suggestion');
check('认领建议接口', r.status === 200, r);
console.log('   认领建议：', JSON.stringify(r.data));
r = await admin.req('GET', `/api/admin/people/${baby.immichPersonId}/similar`);
check('相似人物：排除同框过的', r.status === 200 && Array.isArray(r.data) && r.data.every((p: any) => p.together <= Math.max(1, p.assets * 0.01)), r);
console.log('   相似人物：', JSON.stringify(r.data).slice(0, 200));
r = await admin.req('GET', '/api/admin/duplicates');
check('重复照片接口', r.status === 200 && Array.isArray(r.data), r);
r = await admin.req('GET', '/api/admin/immich/settings');
check('设置里有搜索模型', r.status === 200 && typeof r.data.clipModel === 'string', r.data?.clipModel);

// ---------------------------------------------------------------- 推送
r = await admin.req('GET', '/api/push/key');
check('推送公钥', r.status === 200 && /^[A-Za-z0-9_-]{80,}$/.test(r.data.publicKey), r);
r = await admin.req('POST', '/api/push/test');
check('没有订阅时测试通知返回 400', r.status === 400, r);
r = await admin.req('POST', '/api/push/subscribe', { endpoint: 'not-a-url', keys: { p256dh: 'x', auth: 'y' } });
check('订阅参数校验', r.status === 400, r.status);

// ---------------------------------------------------------------- 只读、受限成员
const inv = (await admin.req('POST', '/api/admin/invites', { role: 'viewer', babyIds: [baby.id] })).data;
const viewer = new Client();
const vname = `v${Date.now() % 100000}`;
r = await viewer.req('POST', '/api/auth/register', { token: inv.token, username: vname, displayName: '测试只读', password: 'password123' });
check('只读成员注册', r.status === 200 || r.status === 201, r);
r = await viewer.req('POST', `/api/babies/${baby.id}/measurements`, { date: baby.birthday, weightKg: 3 });
check('只读成员不能记成长数据', r.status === 403, r.status);
r = await viewer.req('GET', `/api/babies/${baby.id}/measurements`);
check('只读成员能看成长数据', r.status === 200, r.status);
r = await viewer.req('GET', '/api/admin/import-progress');
check('只读成员不能看管理接口', r.status === 403, r.status);
if (other) {
  r = await viewer.req('GET', `/api/babies/${other.id}/review?kind=year&index=0`);
  check('受限成员不能看别的宝宝的回顾', r.status === 404, r.status);
  r = await viewer.req('GET', `/api/search?q=x&baby=${other.id}`);
  check('受限成员不能搜别的宝宝', r.status === 404, r.status);
}

// 清理
await admin.req('DELETE', `/api/journal/${j1.id}`);
await admin.req('DELETE', `/api/measurements/${m1.id}`);
const users = (await admin.req('GET', '/api/admin/users')).data;
const vu = users.find((u: any) => u.username === vname);
if (vu) await admin.req('DELETE', `/api/admin/users/${vu.id}`);

console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
