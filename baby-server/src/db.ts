import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

// 只存 Immich 里没有的数据；照片与 Immich 通过 asset ID / person ID 关联
export const db = new DatabaseSync(join(config.DATA_DIR, 'baby.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS babies (
    id               INTEGER PRIMARY KEY,
    name             TEXT NOT NULL,
    birthday         TEXT NOT NULL,          -- YYYY-MM-DD
    immich_person_id TEXT NOT NULL UNIQUE,   -- Immich 人脸识别出的“人物”
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS milestones (
    id             INTEGER PRIMARY KEY,
    baby_id        INTEGER NOT NULL REFERENCES babies(id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    date           TEXT NOT NULL,            -- YYYY-MM-DD
    note           TEXT NOT NULL DEFAULT '',
    cover_asset_id TEXT,                     -- Immich asset ID
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS milestones_baby ON milestones(baby_id, date);

  -- 拍摄日期更正：原文件和 Immich 都不改（外部图库只读），只在宝宝相册里生效。
  -- 典型情况：影楼相册设计页带着模板的旧日期、相机时钟没调
  CREATE TABLE IF NOT EXISTS date_overrides (
    asset_id   TEXT PRIMARY KEY,             -- Immich asset ID
    taken_at   TEXT NOT NULL,                -- 本地时间 YYYY-MM-DDTHH:MM:SS
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 用户：宝宝相册自己的账号体系，和 Immich 无关
  --   admin  管理员：全部功能 + 成员管理 + 照片库/Immich 设置
  --   member 家人：浏览、收藏、记里程碑、更正日期、建分享链接
  --   viewer 只读：只能浏览
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name    TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
    baby_ids        TEXT,                    -- JSON 数组；NULL 表示能看所有宝宝（管理员总是能看所有）
    disabled        INTEGER NOT NULL DEFAULT 0,
    session_version INTEGER NOT NULL DEFAULT 1, -- 改密码、停用时加一，让已登录的会话失效
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at   TEXT
  );

  -- 邀请链接：管理员生成，家人打开后自己设置用户名和密码
  CREATE TABLE IF NOT EXISTS invites (
    token      TEXT PRIMARY KEY,
    role       TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
    baby_ids   TEXT,
    note       TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL,
    used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 存储（SMB / NFS / WebDAV）：管理员在网页上添加，由挂载服务挂到 /mnt/nas/<id>（只读）
  --   smb：host + share（共享名）；nfs：host + share（共享路径）；webdav：url
  CREATE TABLE IF NOT EXISTS nas_sources (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    protocol   TEXT NOT NULL DEFAULT 'smb',
    host       TEXT NOT NULL DEFAULT '',
    share      TEXT NOT NULL DEFAULT '',
    url        TEXT NOT NULL DEFAULT '',
    sub_path   TEXT NOT NULL DEFAULT '',
    username   TEXT NOT NULL DEFAULT '',
    password   TEXT NOT NULL DEFAULT '',
    vers       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 系统设置（键值），比如宝宝相册自动创建的 Immich 服务账号和密钥
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- 家人分享链接：免登录、只读，只能看到指定宝宝的照片
  CREATE TABLE IF NOT EXISTS shares (
    id         INTEGER PRIMARY KEY,
    token      TEXT NOT NULL UNIQUE,
    label      TEXT NOT NULL,
    baby_ids   TEXT NOT NULL,                -- JSON 数组
    expires_at TEXT,                         -- ISO 时间，NULL 表示永久
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---------------------------------------------------------------- 迁移：旧版本建的表缺少的列

function addColumn(table: string, column: string, definition: string) {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// 早期版本只支持 SMB
addColumn('nas_sources', 'protocol', "TEXT NOT NULL DEFAULT 'smb'");
addColumn('nas_sources', 'url', "TEXT NOT NULL DEFAULT ''");

export type Baby = { id: number; name: string; birthday: string; immichPersonId: string };
export type Milestone = { id: number; babyId: number; title: string; date: string; note: string; coverAssetId: string | null };
export type Share = { id: number; token: string; label: string; babyIds: number[]; expiresAt: string | null; createdAt: string };

const babyCols = 'id, name, birthday, immich_person_id AS immichPersonId';

export const babies = {
  list: () => db.prepare(`SELECT ${babyCols} FROM babies ORDER BY birthday`).all() as Baby[],
  get: (id: number) => db.prepare(`SELECT ${babyCols} FROM babies WHERE id = ?`).get(id) as Baby | undefined,
  create: (b: Omit<Baby, 'id'>) =>
    db
      .prepare(`INSERT INTO babies (name, birthday, immich_person_id) VALUES (?, ?, ?) RETURNING ${babyCols}`)
      .get(b.name, b.birthday, b.immichPersonId) as Baby,
  update: (id: number, b: Pick<Baby, 'name' | 'birthday'>) =>
    db.prepare(`UPDATE babies SET name = ?, birthday = ? WHERE id = ? RETURNING ${babyCols}`).get(b.name, b.birthday, id) as
      | Baby
      | undefined,
  remove: (id: number) => db.prepare('DELETE FROM babies WHERE id = ?').run(id).changes > 0,
  /** 人物被合并后，改为关联到新的人物 */
  relink: (id: number, immichPersonId: string) => db.prepare('UPDATE babies SET immich_person_id = ? WHERE id = ?').run(immichPersonId, id),
};

const milestoneCols = 'id, baby_id AS babyId, title, date, note, cover_asset_id AS coverAssetId';

export const milestones = {
  list: (babyId: number) =>
    db.prepare(`SELECT ${milestoneCols} FROM milestones WHERE baby_id = ? ORDER BY date DESC, id DESC`).all(babyId) as Milestone[],
  get: (id: number) => db.prepare(`SELECT ${milestoneCols} FROM milestones WHERE id = ?`).get(id) as Milestone | undefined,
  create: (m: Omit<Milestone, 'id'>) =>
    db
      .prepare(`INSERT INTO milestones (baby_id, title, date, note, cover_asset_id) VALUES (?, ?, ?, ?, ?) RETURNING ${milestoneCols}`)
      .get(m.babyId, m.title, m.date, m.note, m.coverAssetId) as Milestone,
  update: (id: number, m: Omit<Milestone, 'id' | 'babyId'>) =>
    db
      .prepare(`UPDATE milestones SET title = ?, date = ?, note = ?, cover_asset_id = ? WHERE id = ? RETURNING ${milestoneCols}`)
      .get(m.title, m.date, m.note, m.coverAssetId, id) as Milestone | undefined,
  remove: (id: number) => db.prepare('DELETE FROM milestones WHERE id = ?').run(id).changes > 0,
};

type ShareRow = Omit<Share, 'babyIds'> & { babyIds: string };
const shareCols = 'id, token, label, baby_ids AS babyIds, expires_at AS expiresAt, created_at AS createdAt';
const toShare = (row: ShareRow | undefined): Share | undefined => row && { ...row, babyIds: JSON.parse(row.babyIds) };

export const shares = {
  list: () => (db.prepare(`SELECT ${shareCols} FROM shares ORDER BY id DESC`).all() as ShareRow[]).map((r) => toShare(r)!),
  byToken: (token: string) => toShare(db.prepare(`SELECT ${shareCols} FROM shares WHERE token = ?`).get(token) as ShareRow | undefined),
  create: (s: Omit<Share, 'id' | 'createdAt'>) =>
    toShare(
      db
        .prepare(`INSERT INTO shares (token, label, baby_ids, expires_at) VALUES (?, ?, ?, ?) RETURNING ${shareCols}`)
        .get(s.token, s.label, JSON.stringify(s.babyIds), s.expiresAt) as ShareRow,
    )!,
  remove: (id: number) => db.prepare('DELETE FROM shares WHERE id = ?').run(id).changes > 0,
};

export const dateOverrides = {
  /** asset ID → 更正后的本地时间 */
  all: () =>
    new Map((db.prepare('SELECT asset_id AS id, taken_at AS takenAt FROM date_overrides').all() as { id: string; takenAt: string }[]).map((r) => [r.id, r.takenAt])),
  set: (assetIds: string[], takenAt: string) => {
    const stmt = db.prepare('INSERT INTO date_overrides (asset_id, taken_at) VALUES (?, ?) ON CONFLICT(asset_id) DO UPDATE SET taken_at = excluded.taken_at');
    db.exec('BEGIN');
    try {
      for (const id of assetIds) stmt.run(id, takenAt);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },
  remove: (assetId: string) => db.prepare('DELETE FROM date_overrides WHERE asset_id = ?').run(assetId).changes > 0,
};

// ---------------------------------------------------------------- 用户

export type Role = 'admin' | 'member' | 'viewer';
export type User = {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  /** null 表示能看所有宝宝 */
  babyIds: number[] | null;
  disabled: boolean;
  sessionVersion: number;
  createdAt: string;
  lastLoginAt: string | null;
};
type UserRow = Omit<User, 'babyIds' | 'disabled'> & { babyIds: string | null; disabled: number; passwordHash: string };

const userCols = `id, username, display_name AS displayName, password_hash AS passwordHash, role, baby_ids AS babyIds,
  disabled, session_version AS sessionVersion, created_at AS createdAt, last_login_at AS lastLoginAt`;
const toUser = ({ passwordHash: _, ...r }: UserRow): User => ({
  ...r,
  babyIds: r.babyIds ? JSON.parse(r.babyIds) : null,
  disabled: !!r.disabled,
});

export const users = {
  count: () => (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n,
  list: () => (db.prepare(`SELECT ${userCols} FROM users ORDER BY id`).all() as UserRow[]).map(toUser),
  get: (id: number) => {
    const row = db.prepare(`SELECT ${userCols} FROM users WHERE id = ?`).get(id) as UserRow | undefined;
    return row && toUser(row);
  },
  /** 登录用：同时返回密码哈希 */
  byUsername: (username: string) => {
    const row = db.prepare(`SELECT ${userCols} FROM users WHERE username = ?`).get(username) as UserRow | undefined;
    return row && { user: toUser(row), passwordHash: row.passwordHash };
  },
  create: (u: { username: string; displayName: string; passwordHash: string; role: Role; babyIds: number[] | null }) =>
    toUser(
      db
        .prepare(`INSERT INTO users (username, display_name, password_hash, role, baby_ids) VALUES (?, ?, ?, ?, ?) RETURNING ${userCols}`)
        .get(u.username, u.displayName, u.passwordHash, u.role, u.babyIds ? JSON.stringify(u.babyIds) : null) as UserRow,
    ),
  update: (id: number, u: { displayName: string; role: Role; babyIds: number[] | null; disabled: boolean }) => {
    db.prepare(
      'UPDATE users SET display_name = ?, role = ?, baby_ids = ?, disabled = ?, session_version = session_version + ? WHERE id = ?',
    ).run(u.displayName, u.role, u.babyIds ? JSON.stringify(u.babyIds) : null, u.disabled ? 1 : 0, u.disabled ? 1 : 0, id);
    return users.get(id);
  },
  /** 改密码会让这个用户在所有设备上的登录失效 */
  setPassword: (id: number, passwordHash: string) =>
    db.prepare('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?').run(passwordHash, id).changes > 0,
  touchLogin: (id: number) => db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(id),
  remove: (id: number) => db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0,
  activeAdmins: () => (db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n,
};

// ---------------------------------------------------------------- 邀请

export type Invite = { token: string; role: Role; babyIds: number[] | null; note: string; expiresAt: string; usedBy: number | null; createdAt: string };
type InviteRow = Omit<Invite, 'babyIds'> & { babyIds: string | null };
const inviteCols = 'token, role, baby_ids AS babyIds, note, expires_at AS expiresAt, used_by AS usedBy, created_at AS createdAt';
const toInvite = (r: InviteRow): Invite => ({ ...r, babyIds: r.babyIds ? JSON.parse(r.babyIds) : null });

export const invites = {
  list: () => (db.prepare(`SELECT ${inviteCols} FROM invites ORDER BY created_at DESC`).all() as InviteRow[]).map(toInvite),
  get: (token: string) => {
    const row = db.prepare(`SELECT ${inviteCols} FROM invites WHERE token = ?`).get(token) as InviteRow | undefined;
    return row && toInvite(row);
  },
  create: (i: Omit<Invite, 'usedBy' | 'createdAt'>) =>
    toInvite(
      db
        .prepare(`INSERT INTO invites (token, role, baby_ids, note, expires_at) VALUES (?, ?, ?, ?, ?) RETURNING ${inviteCols}`)
        .get(i.token, i.role, i.babyIds ? JSON.stringify(i.babyIds) : null, i.note, i.expiresAt) as InviteRow,
    ),
  markUsed: (token: string, userId: number) => db.prepare('UPDATE invites SET used_by = ? WHERE token = ?').run(userId, token),
  remove: (token: string) => db.prepare('DELETE FROM invites WHERE token = ?').run(token).changes > 0,
};

// ---------------------------------------------------------------- 系统设置

export const settings = {
  get: (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value,
  set: (key: string, value: string) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value),
  remove: (key: string) => db.prepare('DELETE FROM settings WHERE key = ?').run(key),
};

/** 在一个事务里执行（node:sqlite 是同步的，可以直接包起来） */
export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------- NAS 连接

export type StorageProtocol = 'smb' | 'nfs' | 'webdav';
export type NasSource = {
  id: number;
  name: string;
  protocol: StorageProtocol;
  host: string;
  share: string;
  url: string;
  subPath: string;
  username: string;
  password: string;
  vers: string;
};
const nasCols = 'id, name, protocol, host, share, url, sub_path AS subPath, username, password, vers';

export const nasSources = {
  list: () => db.prepare(`SELECT ${nasCols} FROM nas_sources ORDER BY id`).all() as NasSource[],
  get: (id: number) => db.prepare(`SELECT ${nasCols} FROM nas_sources WHERE id = ?`).get(id) as NasSource | undefined,
  create: (n: Omit<NasSource, 'id'>) =>
    db
      .prepare(
        `INSERT INTO nas_sources (name, protocol, host, share, url, sub_path, username, password, vers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${nasCols}`,
      )
      .get(n.name, n.protocol, n.host, n.share, n.url, n.subPath, n.username, n.password, n.vers) as NasSource,
  update: (id: number, n: Omit<NasSource, 'id'>) =>
    db
      .prepare(
        `UPDATE nas_sources SET name = ?, protocol = ?, host = ?, share = ?, url = ?, sub_path = ?, username = ?, password = ?, vers = ? WHERE id = ? RETURNING ${nasCols}`,
      )
      .get(n.name, n.protocol, n.host, n.share, n.url, n.subPath, n.username, n.password, n.vers, id) as NasSource | undefined,
  remove: (id: number) => db.prepare('DELETE FROM nas_sources WHERE id = ?').run(id).changes > 0,
};
