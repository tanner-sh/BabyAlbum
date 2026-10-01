// 密码哈希：scrypt（Node 内置，不需要第三方依赖）。格式 scrypt$N$r$p$盐$哈希

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;

function derive(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LEN, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, N, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), { N: Number(N), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** 登录失败时也算一次哈希，避免通过响应时间判断用户名是否存在 */
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));
