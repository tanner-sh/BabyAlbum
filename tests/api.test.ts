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
// 隐藏一个人物：不勾“显示已隐藏的”时不出现，勾了才出现（以前 hidden=false 被当成 true）
{
  const all = (await admin.req('GET', '/api/admin/people?hidden=false')).data as any[];
  const target = all.find((p) => !p.baby && p.id !== baby.immichPersonId);
  if (target) {
    await admin.req('PUT', `/api/admin/people/${target.id}`, { isHidden: true });
    const visible = (await admin.req('GET', '/api/admin/people?hidden=false')).data as any[];
    const withHidden = (await admin.req('GET', '/api/admin/people?hidden=true')).data as any[];
    check('隐藏的人物：不显示已隐藏时不出现', !visible.some((p) => p.id === target.id) && visible.every((p) => !p.isHidden), visible.filter((p) => p.isHidden).length);
    check('隐藏的人物：显示已隐藏时出现', withHidden.some((p) => p.id === target.id && p.isHidden));
    await admin.req('PUT', `/api/admin/people/${target.id}`, { isHidden: false });
  }
}
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

// 受限家人（只能看一个宝宝）：只能改、删、分享自己建的相册；看不到的相册不出现
const inv2 = (await admin.req('POST', '/api/admin/invites', { role: 'member', babyIds: [baby.id] })).data;
const member = new Client();
const mname = `m${Date.now() % 100000}`;
r = await member.req('POST', '/api/auth/register', { token: inv2.token, username: mname, displayName: '测试受限家人', password: 'password123' });
check('受限家人注册', r.status === 200 || r.status === 201, r);
if (other) {
  // 管理员建一个相册，只放别的宝宝的、受限家人看不到的照片
  const otherItems = ((await admin.req('GET', `/api/babies/${other.id}/timeline?size=50`)).data.groups as any[]).flatMap((g) => g.items);
  let hiddenFromMember: string | undefined;
  for (const it of otherItems) if ((await member.req('GET', `/api/assets/${it.id}`)).status === 404) { hiddenFromMember = it.id; break; }
  if (hiddenFromMember) {
    const a1 = (await admin.req('POST', '/api/albums', { title: '只有别的宝宝' })).data;
    await admin.req('POST', `/api/albums/${a1.id}/assets`, { assetIds: [hiddenFromMember] });
    const adminShare = (await admin.req('POST', '/api/shares', { label: '相册分享', babyIds: [], albumId: a1.id })).data;
    const list = (await member.req('GET', '/api/albums')).data as any[];
    check('受限家人：看不到的相册不出现在列表里', !list.some((a) => a.id === a1.id), list.map((a) => a.title));
    r = await member.req('GET', `/api/albums/${a1.id}`);
    check('受限家人：打不开看不到的相册', r.status === 404, r.status);
    r = await member.req('PUT', `/api/albums/${a1.id}`, { title: '改个名' });
    check('受限家人：不能改别人的相册', r.status === 403, r.status);
    r = await member.req('DELETE', `/api/albums/${a1.id}`);
    check('受限家人：不能删别人的相册', r.status === 403, r.status);
    r = await member.req('POST', '/api/shares', { label: '偷偷分享', babyIds: [], albumId: a1.id });
    check('受限家人：不能分享别人的相册', r.status === 400, r);
    const memberShares = (await member.req('GET', '/api/shares')).data as any[];
    check('受限家人：看不到别人相册的分享链接', !memberShares.some((x) => x.id === adminShare.id));
    r = await member.req('DELETE', `/api/shares/${adminShare.id}`);
    check('受限家人：不能停用别人相册的分享链接', r.status === 404, r.status);
    // 自己建的相册，放自己能看的照片：可以改、可以分享
    const mine = ((await member.req('GET', `/api/babies/${baby.id}/timeline?size=5`)).data.groups as any[]).flatMap((g) => g.items)[0];
    const a2 = (await member.req('POST', '/api/albums', { title: '我的相册' })).data;
    r = await member.req('POST', `/api/albums/${a2.id}/assets`, { assetIds: [mine.id] });
    check('受限家人：往自己的相册里加照片', r.status === 200, r);
    r = await member.req('POST', '/api/shares', { label: '我的分享', babyIds: [], albumId: a2.id });
    check('受限家人：可以分享自己的相册', r.status === 201, r);
    if (r.status === 201) await member.req('DELETE', `/api/shares/${r.data.id}`);
    // 管理员往受限家人的相册里加了 TA 看不到的照片：这时 TA 不能再分享
    await admin.req('POST', `/api/albums/${a2.id}/assets`, { assetIds: [hiddenFromMember] });
    r = await member.req('POST', '/api/shares', { label: '我的分享', babyIds: [], albumId: a2.id });
    check('受限家人：相册里有看不到的照片时不能分享', r.status === 400, r);
    // 相册里有一张已经从照片库删掉的照片（相册里还留着记录）：受限家人的列表、详情、分享都不能出错
    const gone = crypto.randomUUID();
    const a3 = (await admin.req('POST', '/api/albums', { title: '有删掉的照片' })).data;
    await admin.req('POST', `/api/albums/${a3.id}/assets`, { assetIds: [mine.id, gone] });
    r = await member.req('GET', '/api/albums');
    check('相册里有已删除的照片：受限家人的相册列表正常', r.status === 200 && r.data.some((a: any) => a.id === a3.id && a.count === 1), r.status);
    r = await member.req('GET', `/api/albums/${a3.id}`);
    check('相册里有已删除的照片：受限家人能打开相册', r.status === 200 && r.data.items.length === 1, r.status);
    await admin.req('DELETE', `/api/albums/${a3.id}`);
    await admin.req('DELETE', `/api/shares/${adminShare.id}`);
    await admin.req('DELETE', `/api/albums/${a1.id}`);
    await admin.req('DELETE', `/api/albums/${a2.id}`);
  } else console.log('- 别的宝宝的照片受限家人都能看到，跳过相册权限检查');
}

// 清理
await admin.req('DELETE', `/api/journal/${j1.id}`);
await admin.req('DELETE', `/api/measurements/${m1.id}`);
const users = (await admin.req('GET', '/api/admin/users')).data;
const vu = users.find((u: any) => u.username === vname);
if (vu) await admin.req('DELETE', `/api/admin/users/${vu.id}`);
const mu = users.find((u: any) => u.username === mname);
if (mu) await admin.req('DELETE', `/api/admin/users/${mu.id}`);

console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
