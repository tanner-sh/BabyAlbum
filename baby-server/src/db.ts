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

  -- 成长数据：身高（身长）、体重、头围，和 WHO 生长标准对比
  CREATE TABLE IF NOT EXISTS growth_records (
    id         INTEGER PRIMARY KEY,
    baby_id    INTEGER NOT NULL REFERENCES babies(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,                -- YYYY-MM-DD
    height_cm  REAL,
    weight_kg  REAL,
    head_cm    REAL,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS growth_records_baby ON growth_records(baby_id, date);

  -- 日记：给某一天写几句话，和当天的照片放在一起
  CREATE TABLE IF NOT EXISTS journal_entries (
    id         INTEGER PRIMARY KEY,
    baby_id    INTEGER NOT NULL REFERENCES babies(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,                -- YYYY-MM-DD
    text       TEXT NOT NULL,
    author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS journal_entries_baby ON journal_entries(baby_id, date);

  -- 在宝宝相册里隐藏的照片（比如重复的照片）：只是不显示，存储上的文件和 Immich 都不动
  CREATE TABLE IF NOT EXISTS hidden_assets (
    asset_id   TEXT PRIMARY KEY,             -- Immich asset ID
    reason     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 手机推送（Web Push）的订阅：添加到主屏幕后可以收到生日回顾等通知
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 手动相册：自己挑照片建的相册（满月酒、第一次旅行），可以单独分享
  CREATE TABLE IF NOT EXISTS albums (
    id             INTEGER PRIMARY KEY,
    title          TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    cover_asset_id TEXT,
    created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS album_assets (
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (album_id, asset_id)
  );
  CREATE INDEX IF NOT EXISTS album_assets_asset ON album_assets(asset_id);

  -- 家人互动：点赞、留言。actor 是谁：u:<用户 ID>（登录的家人），s:<分享 ID>:<访客 ID>（分享链接的访客）
  CREATE TABLE IF NOT EXISTS asset_likes (
    asset_id   TEXT NOT NULL,
    actor      TEXT NOT NULL,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (asset_id, actor)
  );
  CREATE TABLE IF NOT EXISTS asset_comments (
    id         INTEGER PRIMARY KEY,
    asset_id   TEXT NOT NULL,
    actor      TEXT NOT NULL,
    name       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS asset_comments_asset ON asset_comments(asset_id, created_at);

  -- 家人分享链接：免登录、只读，只能看到指定宝宝的照片（或者一个相册）
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
// 宝宝性别：用于和 WHO 生长标准对比（男孩、女孩的标准不同）
addColumn('babies', 'sex', 'TEXT');
// 分享链接：访问密码、是否允许下载原图、长辈模式（大字大图）。早期版本的分享都允许下载，保持不变
addColumn('shares', 'password_hash', 'TEXT');
if (!(db.prepare('PRAGMA table_info(shares)').all() as { name: string }[]).some((c) => c.name === 'allow_download')) {
  db.exec('ALTER TABLE shares ADD COLUMN allow_download INTEGER NOT NULL DEFAULT 0; UPDATE shares SET allow_download = 1');
}
addColumn('shares', 'elder_mode', 'INTEGER NOT NULL DEFAULT 0');
// 分享一个相册（这时 baby_ids 是空数组）；是否允许访客点赞、留言
addColumn('shares', 'album_id', 'INTEGER REFERENCES albums(id) ON DELETE CASCADE');
addColumn('shares', 'allow_comments', 'INTEGER NOT NULL DEFAULT 1');
// 每个人想收到哪些推送（JSON），没设置过时全部打开
addColumn('users', 'notify_prefs', 'TEXT');

export type Sex = 'boy' | 'girl';
export type Baby = { id: number; name: string; birthday: string; immichPersonId: string; sex: Sex | null };
export type Milestone = { id: number; babyId: number; title: string; date: string; note: string; coverAssetId: string | null };
export type Share = {
  id: number;
  token: string;
  label: string;
  babyIds: number[];
  expiresAt: string | null;
  createdAt: string;
  /** 设置了访问密码时是密码哈希 */
  passwordHash: string | null;
  allowDownload: boolean;
  elderMode: boolean;
  /** 分享的是一个相册（不是宝宝） */
  albumId: number | null;
  allowComments: boolean;
};

const babyCols = 'id, name, birthday, immich_person_id AS immichPersonId, sex';

export const babies = {
  list: () => db.prepare(`SELECT ${babyCols} FROM babies ORDER BY birthday`).all() as Baby[],
  get: (id: number) => db.prepare(`SELECT ${babyCols} FROM babies WHERE id = ?`).get(id) as Baby | undefined,
  create: (b: Omit<Baby, 'id'>) =>
    db
      .prepare(`INSERT INTO babies (name, birthday, immich_person_id, sex) VALUES (?, ?, ?, ?) RETURNING ${babyCols}`)
      .get(b.name, b.birthday, b.immichPersonId, b.sex) as Baby,
  update: (id: number, b: Pick<Baby, 'name' | 'birthday' | 'sex'>) =>
    db.prepare(`UPDATE babies SET name = ?, birthday = ?, sex = ? WHERE id = ? RETURNING ${babyCols}`).get(b.name, b.birthday, b.sex, id) as
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

type ShareRow = Omit<Share, 'babyIds' | 'allowDownload' | 'elderMode' | 'allowComments'> & {
  babyIds: string;
  allowDownload: number;
  elderMode: number;
  allowComments: number;
};
const shareCols = `id, token, label, baby_ids AS babyIds, expires_at AS expiresAt, created_at AS createdAt,
  password_hash AS passwordHash, allow_download AS allowDownload, elder_mode AS elderMode, album_id AS albumId, allow_comments AS allowComments`;
const toShare = (row: ShareRow | undefined): Share | undefined =>
  row && { ...row, babyIds: JSON.parse(row.babyIds), allowDownload: !!row.allowDownload, elderMode: !!row.elderMode, allowComments: !!row.allowComments };
export type ShareOptions = Pick<Share, 'label' | 'babyIds' | 'expiresAt' | 'passwordHash' | 'allowDownload' | 'elderMode' | 'albumId' | 'allowComments'>;

export const shares = {
  list: () => (db.prepare(`SELECT ${shareCols} FROM shares ORDER BY id DESC`).all() as ShareRow[]).map((r) => toShare(r)!),
  byToken: (token: string) => toShare(db.prepare(`SELECT ${shareCols} FROM shares WHERE token = ?`).get(token) as ShareRow | undefined),
  get: (id: number) => toShare(db.prepare(`SELECT ${shareCols} FROM shares WHERE id = ?`).get(id) as ShareRow | undefined),
  create: (s: ShareOptions & { token: string }) =>
    toShare(
      db
        .prepare(
          `INSERT INTO shares (token, label, baby_ids, expires_at, password_hash, allow_download, elder_mode, album_id, allow_comments)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${shareCols}`,
        )
        .get(
          s.token,
          s.label,
          JSON.stringify(s.babyIds),
          s.expiresAt,
          s.passwordHash,
          s.allowDownload ? 1 : 0,
          s.elderMode ? 1 : 0,
          s.albumId,
          s.allowComments ? 1 : 0,
        ) as ShareRow,
    )!,
  update: (id: number, s: ShareOptions) =>
    toShare(
      db
        .prepare(
          `UPDATE shares SET label = ?, baby_ids = ?, expires_at = ?, password_hash = ?, allow_download = ?, elder_mode = ?, album_id = ?, allow_comments = ?
           WHERE id = ? RETURNING ${shareCols}`,
        )
        .get(
          s.label,
          JSON.stringify(s.babyIds),
          s.expiresAt,
          s.passwordHash,
          s.allowDownload ? 1 : 0,
          s.elderMode ? 1 : 0,
          s.albumId,
          s.allowComments ? 1 : 0,
          id,
        ) as ShareRow | undefined,
    ),
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

// ---------------------------------------------------------------- 成长数据

export type GrowthRecord = { id: number; babyId: number; date: string; heightCm: number | null; weightKg: number | null; headCm: number | null; note: string };
const growthCols = 'id, baby_id AS babyId, date, height_cm AS heightCm, weight_kg AS weightKg, head_cm AS headCm, note';

export const growthRecords = {
  list: (babyId: number) => db.prepare(`SELECT ${growthCols} FROM growth_records WHERE baby_id = ? ORDER BY date, id`).all(babyId) as GrowthRecord[],
  get: (id: number) => db.prepare(`SELECT ${growthCols} FROM growth_records WHERE id = ?`).get(id) as GrowthRecord | undefined,
  create: (r: Omit<GrowthRecord, 'id'>) =>
    db
      .prepare(`INSERT INTO growth_records (baby_id, date, height_cm, weight_kg, head_cm, note) VALUES (?, ?, ?, ?, ?, ?) RETURNING ${growthCols}`)
      .get(r.babyId, r.date, r.heightCm, r.weightKg, r.headCm, r.note) as GrowthRecord,
  update: (id: number, r: Omit<GrowthRecord, 'id' | 'babyId'>) =>
    db
      .prepare(`UPDATE growth_records SET date = ?, height_cm = ?, weight_kg = ?, head_cm = ?, note = ? WHERE id = ? RETURNING ${growthCols}`)
      .get(r.date, r.heightCm, r.weightKg, r.headCm, r.note, id) as GrowthRecord | undefined,
  remove: (id: number) => db.prepare('DELETE FROM growth_records WHERE id = ?').run(id).changes > 0,
};

// ---------------------------------------------------------------- 日记

export type JournalEntry = { id: number; babyId: number; date: string; text: string; authorId: number | null; authorName: string | null; createdAt: string; updatedAt: string };
const journalCols = `j.id, j.baby_id AS babyId, j.date, j.text, j.author_id AS authorId, u.display_name AS authorName,
  j.created_at AS createdAt, j.updated_at AS updatedAt`;
const journalFrom = 'journal_entries j LEFT JOIN users u ON u.id = j.author_id';

export const journal = {
  list: (babyId: number) => db.prepare(`SELECT ${journalCols} FROM ${journalFrom} WHERE j.baby_id = ? ORDER BY j.date DESC, j.id DESC`).all(babyId) as JournalEntry[],
  get: (id: number) => db.prepare(`SELECT ${journalCols} FROM ${journalFrom} WHERE j.id = ?`).get(id) as JournalEntry | undefined,
  create: (e: { babyId: number; date: string; text: string; authorId: number }) => {
    const { id } = db.prepare('INSERT INTO journal_entries (baby_id, date, text, author_id) VALUES (?, ?, ?, ?) RETURNING id').get(e.babyId, e.date, e.text, e.authorId) as { id: number };
    return journal.get(id)!;
  },
  update: (id: number, e: { date: string; text: string }) => {
    db.prepare("UPDATE journal_entries SET date = ?, text = ?, updated_at = datetime('now') WHERE id = ?").run(e.date, e.text, id);
    return journal.get(id);
  },
  remove: (id: number) => db.prepare('DELETE FROM journal_entries WHERE id = ?').run(id).changes > 0,
};

// ---------------------------------------------------------------- 在相册里隐藏的照片

export const hiddenAssets = {
  ids: () => new Set((db.prepare('SELECT asset_id AS id FROM hidden_assets').all() as { id: string }[]).map((r) => r.id)),
  list: () => db.prepare('SELECT asset_id AS assetId, reason, created_at AS createdAt FROM hidden_assets ORDER BY created_at DESC').all() as { assetId: string; reason: string; createdAt: string }[],
  add: (assetIds: string[], reason: string) =>
    transaction(() => {
      const stmt = db.prepare('INSERT INTO hidden_assets (asset_id, reason) VALUES (?, ?) ON CONFLICT(asset_id) DO NOTHING');
      for (const id of assetIds) stmt.run(id, reason);
    }),
  remove: (assetId: string) => db.prepare('DELETE FROM hidden_assets WHERE asset_id = ?').run(assetId).changes > 0,
};

// ---------------------------------------------------------------- 推送订阅

export type PushSubscriptionRow = { endpoint: string; userId: number; p256dh: string; auth: string };

export const pushSubscriptions = {
  all: () => db.prepare('SELECT endpoint, user_id AS userId, p256dh, auth FROM push_subscriptions').all() as PushSubscriptionRow[],
  forUser: (userId: number) => db.prepare('SELECT endpoint, user_id AS userId, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId) as PushSubscriptionRow[],
  save: (s: PushSubscriptionRow) =>
    db
      .prepare('INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth')
      .run(s.endpoint, s.userId, s.p256dh, s.auth),
  remove: (endpoint: string) => db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0,
};

// ---------------------------------------------------------------- 手动相册

export type Album = { id: number; title: string; description: string; coverAssetId: string | null; createdBy: number | null; createdAt: string; updatedAt: string; count: number };
const albumCols = `a.id, a.title, a.description, a.cover_asset_id AS coverAssetId, a.created_by AS createdBy, a.created_at AS createdAt, a.updated_at AS updatedAt,
  (SELECT count(*) FROM album_assets x WHERE x.album_id = a.id) AS count`;

export const albums = {
  list: () => db.prepare(`SELECT ${albumCols} FROM albums a ORDER BY a.updated_at DESC, a.id DESC`).all() as Album[],
  get: (id: number) => db.prepare(`SELECT ${albumCols} FROM albums a WHERE a.id = ?`).get(id) as Album | undefined,
  create: (a: { title: string; description: string; createdBy: number }) => {
    const { id } = db.prepare('INSERT INTO albums (title, description, created_by) VALUES (?, ?, ?) RETURNING id').get(a.title, a.description, a.createdBy) as { id: number };
    return albums.get(id)!;
  },
  update: (id: number, a: { title: string; description: string; coverAssetId: string | null }) => {
    db.prepare("UPDATE albums SET title = ?, description = ?, cover_asset_id = ?, updated_at = datetime('now') WHERE id = ?").run(a.title, a.description, a.coverAssetId, id);
    return albums.get(id);
  },
  remove: (id: number) => db.prepare('DELETE FROM albums WHERE id = ?').run(id).changes > 0,
  assetIds: (id: number) => (db.prepare('SELECT asset_id AS id FROM album_assets WHERE album_id = ? ORDER BY added_at').all(id) as { id: string }[]).map((r) => r.id),
  has: (id: number, assetId: string) => !!db.prepare('SELECT 1 FROM album_assets WHERE album_id = ? AND asset_id = ?').get(id, assetId),
  add: (id: number, assetIds: string[]) =>
    transaction(() => {
      const stmt = db.prepare('INSERT INTO album_assets (album_id, asset_id) VALUES (?, ?) ON CONFLICT DO NOTHING');
      let added = 0;
      for (const a of assetIds) added += Number(stmt.run(id, a).changes);
      db.prepare("UPDATE albums SET updated_at = datetime('now') WHERE id = ?").run(id);
      return added;
    }),
  removeAssets: (id: number, assetIds: string[]) =>
    transaction(() => {
      const stmt = db.prepare('DELETE FROM album_assets WHERE album_id = ? AND asset_id = ?');
      for (const a of assetIds) stmt.run(id, a);
      // 封面被移出去了就清掉
      db.prepare("UPDATE albums SET cover_asset_id = NULL WHERE id = ? AND cover_asset_id NOT IN (SELECT asset_id FROM album_assets WHERE album_id = ?)").run(id, id);
      db.prepare("UPDATE albums SET updated_at = datetime('now') WHERE id = ?").run(id);
    }),
};

// ---------------------------------------------------------------- 点赞、留言

export type Comment = { id: number; assetId: string; actor: string; name: string; text: string; createdAt: string };
const commentCols = 'id, asset_id AS assetId, actor, name, text, created_at AS createdAt';

export const social = {
  likes: (assetId: string) =>
    db.prepare('SELECT actor, name, created_at AS createdAt FROM asset_likes WHERE asset_id = ? ORDER BY created_at').all(assetId) as { actor: string; name: string; createdAt: string }[],
  toggleLike: (assetId: string, actor: string, name: string) =>
    transaction(() => {
      if (db.prepare('DELETE FROM asset_likes WHERE asset_id = ? AND actor = ?').run(assetId, actor).changes) return false;
      db.prepare('INSERT INTO asset_likes (asset_id, actor, name) VALUES (?, ?, ?)').run(assetId, actor, name);
      return true;
    }),
  comments: (assetId: string) => db.prepare(`SELECT ${commentCols} FROM asset_comments WHERE asset_id = ? ORDER BY created_at, id`).all(assetId) as Comment[],
  comment: (id: number) => db.prepare(`SELECT ${commentCols} FROM asset_comments WHERE id = ?`).get(id) as Comment | undefined,
  addComment: (c: { assetId: string; actor: string; name: string; text: string }) =>
    db.prepare(`INSERT INTO asset_comments (asset_id, actor, name, text) VALUES (?, ?, ?, ?) RETURNING ${commentCols}`).get(c.assetId, c.actor, c.name, c.text) as Comment,
  removeComment: (id: number) => db.prepare('DELETE FROM asset_comments WHERE id = ?').run(id).changes > 0,
  /** 最近的互动（点赞和留言），首页“家人的留言”用 */
  recent: (limit: number) =>
    db
      .prepare(
        `SELECT * FROM (
           SELECT 'comment' AS kind, asset_id AS assetId, actor, name, text, created_at AS createdAt FROM asset_comments
           UNION ALL
           SELECT 'like' AS kind, asset_id AS assetId, actor, name, '' AS text, created_at AS createdAt FROM asset_likes
         ) ORDER BY createdAt DESC LIMIT ?`,
      )
      .all(limit) as { kind: 'comment' | 'like'; assetId: string; actor: string; name: string; text: string; createdAt: string }[],
  counts: (assetIds: string[]) => {
    if (!assetIds.length) return new Map<string, { likes: number; comments: number }>();
    const marks = assetIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT asset_id AS id, sum(l) AS likes, sum(c) AS comments FROM (
           SELECT asset_id, 1 AS l, 0 AS c FROM asset_likes WHERE asset_id IN (${marks})
           UNION ALL SELECT asset_id, 0, 1 FROM asset_comments WHERE asset_id IN (${marks})
         ) GROUP BY asset_id`,
      )
      .all(...assetIds, ...assetIds) as { id: string; likes: number; comments: number }[];
    return new Map(rows.map((r) => [r.id, { likes: r.likes, comments: r.comments }]));
  },
};

// ---------------------------------------------------------------- 推送偏好

export type NotifyPrefs = { milestones: boolean; weekly: boolean; family: boolean; system: boolean };
const DEFAULT_PREFS: NotifyPrefs = { milestones: true, weekly: true, family: true, system: true };

export const notifyPrefs = {
  get: (userId: number): NotifyPrefs => {
    const row = db.prepare('SELECT notify_prefs AS prefs FROM users WHERE id = ?').get(userId) as { prefs: string | null } | undefined;
    return { ...DEFAULT_PREFS, ...(row?.prefs ? JSON.parse(row.prefs) : {}) };
  },
  set: (userId: number, prefs: Partial<NotifyPrefs>) => {
    const next = { ...notifyPrefs.get(userId), ...prefs };
    db.prepare('UPDATE users SET notify_prefs = ? WHERE id = ?').run(JSON.stringify(next), userId);
    return next;
  },
};
