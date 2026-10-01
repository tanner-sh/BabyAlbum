// 管理员忘记密码时，在服务器上直接重置（也可以用来重新启用被停用的账号）：
//   docker compose exec baby-server node src/cli/reset-password.ts <用户名> <新密码>

import { users } from '../db.ts';
import { hashPassword } from '../password.ts';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.error('用法：node src/cli/reset-password.ts <用户名> <新密码（至少 8 位）>');
  console.error('现有用户：', users.list().map((u) => `${u.username}（${u.role}${u.disabled ? '，已停用' : ''}）`).join('、') || '无');
  process.exit(1);
}
const found = users.byUsername(username);
if (!found) {
  console.error(`没有用户 ${username}`);
  process.exit(1);
}
users.setPassword(found.user.id, await hashPassword(password));
if (found.user.disabled) users.update(found.user.id, { ...found.user, disabled: false });
console.log(`已重置 ${found.user.displayName}（${username}）的密码${found.user.disabled ? '，并重新启用' : ''}`);
