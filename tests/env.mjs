// 测试环境的公共设置：被测地址、管理员账号、Chrome 路径、截图目录。都可以用环境变量覆盖（CI 里用）
import { mkdirSync, readFileSync } from 'node:fs';

export const BASE = process.env.BASE ?? 'http://localhost:3000';
// scripts/dev-up.sh 初始化测试环境时生成的账号
export const creds = JSON.parse(readFileSync(new URL('../dev-data/dev-credentials.json', import.meta.url), 'utf8'));
export const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

/** 测试结果计数：check(名字, 是否通过, 失败时显示的内容) */
export function checker() {
  const result = { passed: 0, failed: 0 };
  const check = (name, ok, detail) => {
    if (ok) result.passed++;
    else result.failed++;
    console.log(`${ok ? '✓' : '✗'} ${name}${ok || detail === undefined ? '' : `  ${String(JSON.stringify(detail)).slice(0, 300)}`}`);
  };
  const done = () => {
    console.log(`\n通过 ${result.passed}，失败 ${result.failed}`);
    process.exit(result.failed ? 1 : 0);
  };
  return { check, done, result };
}
