import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, HardDrive, Pencil, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { get, request, type NasOverview, type NasSource, type StorageProtocol } from '../../api';
import { ErrorBox, Modal, Spinner } from '../../components/ui';

const PROTOCOLS: { value: StorageProtocol; label: string; hint: string }[] = [
  { value: 'smb', label: 'SMB', hint: '大多数 NAS、Windows 和 macOS 的共享文件夹（Samba）' },
  { value: 'nfs', label: 'NFS', hint: 'Linux 服务器、开启了 NFS 的 NAS；按设备 IP 授权，不需要账号' },
  { value: 'webdav', label: 'WebDAV', hint: '网盘或开启了 WebDAV 的服务器；大量读取时比较慢' },
];

const PROTOCOL_LABEL: Record<StorageProtocol, string> = { smb: 'SMB', nfs: 'NFS', webdav: 'WebDAV' };

/** 拼路径，去掉多余的斜杠 */
const joinPath = (...parts: string[]) => parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

/** 显示用的位置：//地址/共享/子目录、地址:/路径/子目录、https://…/子目录 */
function location(n: Pick<NasSource, 'protocol' | 'host' | 'share' | 'url' | 'subPath'>) {
  if (n.protocol === 'nfs') return `${n.host}:/${joinPath(n.share, n.subPath)}`;
  if (n.protocol === 'webdav') return [n.url.replace(/\/+$/, ''), joinPath(n.subPath)].filter(Boolean).join('/');
  return `//${joinPath(n.host, n.share, n.subPath)}`;
}

/** 存储（SMB / NFS / WebDAV）+ 备份位置：全部在网页上配置，不需要改 Docker 配置 */
export function StorageSection() {
  const queryClient = useQueryClient();
  const nas = useQuery({ queryKey: ['admin', 'nas'], queryFn: () => get<NasOverview>('/api/admin/nas'), refetchInterval: 30_000 });
  const [editing, setEditing] = useState<NasSource | 'new' | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  if (nas.isPending) return <Spinner />;
  if (nas.isError) return <ErrorBox error={nas.error} />;
  const { sources, mounter, backup } = nas.data;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin'] });

  async function reconnect(n: NasSource) {
    setBusy(n.id);
    await request('POST', `/api/admin/nas/${n.id}/reconnect`).catch((e) => alert(e.message));
    setBusy(null);
    await refresh();
  }

  async function remove(n: NasSource) {
    if (!confirm(`删除存储“${n.name}”？\n\n只是断开连接，存储上的文件不受影响。`)) return;
    try {
      await request('DELETE', `/api/admin/nas/${n.id}`);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : '删除失败');
    }
  }

  const backupSource = backup && sources.find((s) => s.id === backup.sourceId);

  return (
    <section>
      <div className="section-actions">
        <div>
          <h2>存储</h2>
          <p className="muted">存放照片的地方，支持 SMB、NFS、WebDAV，只读连接。可以添加多个，断开后自动重连。</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')} disabled={!mounter}>
          <Plus size={16} />
          添加存储
        </button>
      </div>
      {!mounter && <div className="error-box">挂载服务（nas-mounter 容器）没有运行，暂时不能连接存储。请检查它的运行状态和日志。</div>}
      {!sources.length ? (
        <div className="empty">
          <p className="empty-title">还没有添加存储</p>
          <p>点“添加存储”，连接存放照片的 NAS、服务器或网盘。</p>
        </div>
      ) : (
        sources.map((n) => (
          <div key={n.id} className="card library-card">
            <div className="library-head">
              <div>
                <strong>
                  <HardDrive size={16} /> {n.name}
                  <span className="badge">{PROTOCOL_LABEL[n.protocol]}</span>
                </strong>
                <span className="muted">
                  {location(n)}
                  {n.username ? ` · 账号 ${n.username}` : ''}
                  {n.libraries.length ? ` · 用在：${n.libraries.join('、')}` : ' · 还没有导入照片'}
                </span>
              </div>
              <div className="share-actions">
                <StorageStatus status={n.status} />
                <button className="icon-btn" onClick={() => reconnect(n)} disabled={busy === n.id} title="重新连接" aria-label="重新连接">
                  <RefreshCw size={18} />
                </button>
                <button className="icon-btn" onClick={() => setEditing(n)} aria-label="编辑">
                  <Pencil size={18} />
                </button>
                <button className="icon-btn" onClick={() => remove(n)} aria-label="删除">
                  <Trash2 size={18} />
                </button>
              </div>
            </div>
            {n.status.state === 'error' && <p className="text-danger nas-error">{n.status.error}</p>}
          </div>
        ))
      )}

      <div className="card backup-row">
        <div>
          <strong>数据库备份位置</strong>
          <span className="muted">
            {backup && backupSource
              ? `${backupSource.name}：${location({ ...backupSource, subPath: joinPath(backupSource.subPath, backup.subPath) })}`
              : '本机（运行宝宝相册的这台设备出故障会丢失，建议放到存储上）'}
          </span>
          {backup?.status.state === 'error' && <span className="text-danger">{backup.status.error}</span>}
        </div>
        <button className="btn" onClick={() => setBackupOpen(true)} disabled={!sources.length || !mounter}>
          修改
        </button>
      </div>

      {editing && <StorageEditor source={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {backupOpen && <BackupEditor overview={nas.data} onClose={() => setBackupOpen(false)} />}
    </section>
  );
}

function StorageStatus({ status }: { status: NasSource['status'] }) {
  if (status.state === 'ok')
    return (
      <span className="nas-status ok">
        <CheckCircle2 size={14} /> 已连接
      </span>
    );
  if (status.state === 'error')
    return (
      <span className="nas-status error">
        <TriangleAlert size={14} /> 连接失败
      </span>
    );
  return <span className="nas-status">连接中…</span>;
}

const DEFAULT_VERS: Record<StorageProtocol, string> = { smb: '3.0', nfs: '4.1', webdav: '' };

function StorageEditor({ source, onClose }: { source: NasSource | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: source?.name ?? '',
    protocol: source?.protocol ?? ('smb' as StorageProtocol),
    host: source?.host ?? '',
    share: source?.share ?? '',
    url: source?.url ?? '',
    subPath: source?.subPath ?? '',
    username: source?.username ?? '',
    password: '',
    vers: source?.vers || DEFAULT_VERS[source?.protocol ?? 'smb'],
  });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; folders?: string[] } | null>(null);
  const set = (k: keyof typeof form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setResult(null);
  };
  const setProtocol = (p: StorageProtocol) => {
    setForm((f) => ({ ...f, protocol: p, vers: DEFAULT_VERS[p] }));
    setResult(null);
  };
  // 原来就是这个协议的存储，密码可以不填（沿用原来的）
  const keepsPassword = !!source && source.protocol === form.protocol;

  const payload = () => {
    const base = { name: form.name, protocol: form.protocol, subPath: form.subPath };
    if (form.protocol === 'nfs') return { ...base, host: form.host, share: form.share, vers: form.vers };
    if (form.protocol === 'webdav') return { ...base, url: form.url, username: form.username, password: form.password || undefined };
    return { ...base, host: form.host, share: form.share, username: form.username, password: form.password || undefined, vers: form.vers };
  };

  async function test() {
    setTesting(true);
    try {
      const r = await request<{ folders: string[] }>('POST', '/api/admin/nas/test', { ...payload(), id: keepsPassword ? source!.id : undefined });
      setResult({ ok: true, message: `连接成功，里面有 ${r.folders.length} 个文件夹`, folders: r.folders });
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : '连接失败' });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      if (source) await request('PUT', `/api/admin/nas/${source.id}`, payload());
      else await request('POST', '/api/admin/nas', payload());
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      onClose();
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : '保存失败' });
      setSaving(false);
    }
  }

  const ready =
    form.name.trim() &&
    (form.protocol === 'webdav'
      ? /^https?:\/\//.test(form.url.trim())
      : form.host.trim() && form.share.trim() && (form.protocol === 'nfs' || (form.username.trim() && (keepsPassword || form.password))));

  return (
    <Modal
      title={source ? `编辑 ${source.name}` : '添加存储'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={test} disabled={!ready || testing}>
            {testing ? '连接中…' : '测试连接'}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!ready || saving}>
            {saving ? '连接中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="form">
        <div className="field">
          <span>连接方式</span>
          <div className="role-picker">
            {PROTOCOLS.map((p) => (
              <button key={p.value} type="button" className={`role-option ${form.protocol === p.value ? 'selected' : ''}`} onClick={() => setProtocol(p.value)}>
                <strong>{p.label}</strong>
                <span className="muted">{p.hint}</span>
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>名称（自己看的，比如“客厅 NAS”）</span>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={30} />
        </label>

        {form.protocol === 'webdav' ? (
          <label className="field">
            <span>地址</span>
            <input value={form.url} onChange={(e) => set('url', e.target.value.trim())} placeholder="https://dav.example.com/dav" autoComplete="off" />
          </label>
        ) : (
          <>
            <label className="field">
              <span>地址（IP 或主机名）</span>
              <input value={form.host} onChange={(e) => set('host', e.target.value.trim())} placeholder="192.168.1.10" autoComplete="off" />
            </label>
            <label className="field">
              <span>{form.protocol === 'nfs' ? '共享路径（在存储的 NFS 设置里能看到，比如 /volume1/photos）' : '共享名（在电脑上连接时看到的第一层共享文件夹）'}</span>
              <input
                value={form.share}
                onChange={(e) => set('share', e.target.value.trim())}
                placeholder={form.protocol === 'nfs' ? '/volume1/photos' : 'photos'}
                autoComplete="off"
              />
            </label>
          </>
        )}

        <label className="field">
          <span>只连接里面的某个文件夹（可选，留空表示全部）</span>
          <input value={form.subPath} onChange={(e) => set('subPath', e.target.value)} placeholder="比如：宝宝照片" />
        </label>

        {form.protocol !== 'nfs' && (
          <div className="inline-fields">
            <label className="field">
              <span>用户名{form.protocol === 'webdav' && '（没有可以不填）'}</span>
              <input value={form.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
            </label>
            <label className="field">
              <span>密码{keepsPassword && '（不修改请留空）'}</span>
              <input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
            </label>
          </div>
        )}

        {form.protocol !== 'webdav' && (
          <details>
            <summary className="muted">高级</summary>
            <label className="field">
              <span>{form.protocol === 'nfs' ? 'NFS 版本' : 'SMB 协议版本'}（连不上时可以试试别的版本）</span>
              <select value={form.vers} onChange={(e) => set('vers', e.target.value)}>
                {(form.protocol === 'nfs' ? ['4.2', '4.1', '4', '3'] : ['3.1.1', '3.0', '2.1', '2.0', '1.0']).map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </details>
        )}

        <p className="muted">
          {form.protocol === 'nfs'
            ? 'NFS 按设备 IP 授权：请在存储的 NFS 设置里允许运行宝宝相册的这台设备的 IP（只读即可）。'
            : '建议给宝宝相册单独建一个只读账号。'}
          宝宝相册只读访问，不会修改、移动或删除任何文件。
          {form.protocol === 'webdav' && ' WebDAV 读取大量照片和视频比较慢，首次导入会花更长时间。'}
        </p>
        {result && (
          <div className={result.ok ? 'success-box' : 'error-box'}>
            {result.message}
            {result.folders && result.folders.length > 0 && (
              <div className="muted test-folders">
                {result.folders.slice(0, 12).join('、')}
                {result.folders.length > 12 ? ' …' : ''}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function BackupEditor({ overview, onClose }: { overview: NasOverview; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [sourceId, setSourceId] = useState<number | null>(overview.backup?.sourceId ?? overview.sources[0]?.id ?? null);
  const [subPath, setSubPath] = useState(overview.backup?.subPath ?? 'babyalbum-backup');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await request('PUT', '/api/admin/backup', { sourceId, subPath });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'nas'] });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      setSaving(false);
    }
  }

  return (
    <Modal
      title="数据库备份位置"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving || (sourceId !== null && !subPath.trim())}>
            {saving ? '测试写入中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="form">
        <p className="muted">Immich 和宝宝相册每天各备份一次数据库（人物、收藏、宝宝档案、里程碑等）。放到存储上，运行宝宝相册的设备出故障也不会丢。</p>
        <div className="role-picker">
          <button type="button" className={`role-option ${sourceId === null ? 'selected' : ''}`} onClick={() => setSourceId(null)}>
            <strong>本机</strong>
            <span className="muted">不推荐</span>
          </button>
          {overview.sources.map((s) => (
            <button key={s.id} type="button" className={`role-option ${sourceId === s.id ? 'selected' : ''}`} onClick={() => setSourceId(s.id)}>
              <strong>{s.name}</strong>
              <span className="muted">{location(s)}</span>
            </button>
          ))}
        </div>
        {sourceId !== null && (
          <label className="field">
            <span>文件夹（在上面这个位置下面；需要可写，没有的话请先建好）</span>
            <input value={subPath} onChange={(e) => setSubPath(e.target.value)} />
          </label>
        )}
        {error && <div className="error-box">{error}</div>}
      </div>
    </Modal>
  );
}
