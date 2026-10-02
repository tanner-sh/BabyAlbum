import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Folder, FolderPlus, Pause, Play, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { get, request, type FolderListing, type ImmichOverview, type Library, type NasOverview, type Queue } from '../../api';
import { attempt, ErrorBox, Modal, Spinner, useConfirm } from '../../components/ui';
import { formatBytes, formatServerTime } from '../../format';
import { ImportProgressCard } from './ImportProgress';
import { StorageSection } from './StorageSection';

const STATE_TEXT = {
  connecting: '正在连接照片服务…',
  unreachable: '照片服务（Immich）暂时连不上，正在重试',
  needs_credentials: '需要连接 Immich',
  connected: '照片服务运行正常',
};

/** 照片库：连接状态、导入的文件夹、后台处理进度 */
export function LibraryPage() {
  const overview = useQuery({
    queryKey: ['admin', 'immich'],
    queryFn: () => get<ImmichOverview>('/api/admin/immich'),
    // 有任务在跑时每 5 秒刷新一次进度
    refetchInterval: (q) => (q.state.data?.queues?.some((x) => x.active + x.waiting > 0) || q.state.data?.status.state !== 'connected' ? 5000 : 30000),
  });
  const [editing, setEditing] = useState<Library | 'new' | null>(null);

  if (overview.isPending) return <Spinner />;
  if (overview.isError) return <ErrorBox error={overview.error} />;
  const o = overview.data;

  return (
    <div className="admin-page">
      <section className="card">
        <div className="status-line">
          <span className={`status-dot ${o.status.state}`} />
          <strong>{STATE_TEXT[o.status.state]}</strong>
          {o.version && <span className="muted">Immich {o.version}</span>}
        </div>
        {o.status.error && <p className="muted">{o.status.error}</p>}
        {o.status.state === 'needs_credentials' && <ConnectForm />}
        {o.stats && o.storage && (
          <div className="stats">
            <Stat label="照片" value={o.stats.photos.toLocaleString()} />
            <Stat label="视频" value={o.stats.videos.toLocaleString()} />
            <Stat
              label="原始文件总大小"
              value={formatBytes(o.stats.usage) || '—'}
              hint={o.stats.counting ? '统计中，读完所有文件的信息后才准确' : '在存储上，只读'}
            />
            <Stat
              label="本机存储（缩略图等）"
              value={o.storage.immichData === null ? '统计中' : formatBytes(o.storage.immichData) || '0 B'}
              hint={`所在磁盘已用 ${formatBytes(o.storage.diskUsed)} / 共 ${formatBytes(o.storage.diskSize)}，剩余 ${formatBytes(o.storage.diskAvailable)}`}
            />
          </div>
        )}
      </section>

      {o.status.state === 'connected' && <ImportProgressCard />}

      <StorageSection />

      {o.status.state === 'connected' && (
        <>
          <section>
            <div className="section-actions">
              <div>
                <h2>导入的文件夹</h2>
                <p className="muted">从上面的存储里选择要导入的文件夹。只读访问，不会修改、移动或删除原文件；新增的照片会在定时扫描时自动导入。</p>
              </div>
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                <FolderPlus size={16} />
                添加照片库
              </button>
            </div>
            {!o.libraries?.length ? (
              <div className="empty">
                <p className="empty-title">还没有导入照片</p>
                <p>先在上面添加存储，再点“添加照片库”，选择存放宝宝照片的文件夹。</p>
              </div>
            ) : (
              o.libraries.map((l) => <LibraryCard key={l.id} library={l} nasRoot={o.nasRoot} counting={!!o.stats?.counting} onEdit={() => setEditing(l)} />)
            )}
          </section>
          <QueueSection queues={o.queues ?? []} />
        </>
      )}
      {editing && <LibraryEditor library={editing === 'new' ? null : editing} nasRoot={o.nasRoot} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
      {hint && <span className="muted">{hint}</span>}
    </div>
  );
}

function ConnectForm() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await request('POST', '/api/admin/immich/connect', { email, password });
      await queryClient.invalidateQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接失败');
    }
    setBusy(false);
  }
  return (
    <form className="form" onSubmit={submit}>
      <p className="muted">这个 Immich 之前已经初始化过了。输入一次它的管理员邮箱和密码，宝宝相册会创建自己的访问密钥，之后不再需要。</p>
      <div className="inline-fields">
        <input placeholder="Immich 管理员邮箱" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input placeholder="密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button className="btn btn-primary" disabled={busy}>
          {busy ? '连接中…' : '连接'}
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}
    </form>
  );
}

/** /mnt/nas/1/宝宝相册 → 客厅 NAS / 宝宝相册（显示存储的名字） */
function relativePath(path: string, root: string, nasNames: Map<string, string>) {
  if (path === root) return '全部存储';
  const [first, ...rest] = path.slice(root.length + 1).split('/');
  return [nasNames.get(first) ?? first, ...rest].join(' / ');
}

function useNasNames() {
  const nas = useQuery({ queryKey: ['admin', 'nas'], queryFn: () => get<NasOverview>('/api/admin/nas') });
  return new Map((nas.data?.sources ?? []).map((n) => [String(n.id), n.name]));
}

function LibraryCard({ library, nasRoot, counting, onEdit }: { library: Library; nasRoot: string; counting: boolean; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const nasNames = useNasNames();
  const [scanning, setScanning] = useState(false);
  const [ask, confirmDialog] = useConfirm();
  async function scan() {
    setScanning(true);
    await attempt(() => request('POST', `/api/admin/libraries/${library.id}/scan`), '已开始扫描，新照片会陆续出现');
    setScanning(false);
    await queryClient.invalidateQueries({ queryKey: ['admin', 'immich'] });
  }
  function remove() {
    ask({
      title: '移除照片库',
      message: `从照片库中移除“${library.name}”？宝宝相册将不再显示这些照片（存储上的文件不受影响，之后可以重新导入）。`,
      confirmLabel: '移除',
      danger: true,
      action: async () => {
        await request('DELETE', `/api/admin/libraries/${library.id}`);
        await queryClient.invalidateQueries();
      },
    });
  }
  return (
    <div className="card library-card">
      {confirmDialog}
      <div className="library-head">
        <div>
          <strong>{library.name}</strong>
          <span className="muted">
            {library.assetCount.toLocaleString()} 个文件{library.usage ? `，${formatBytes(library.usage)}${counting ? '（统计中）' : ''}` : ''} · {library.refreshedAt ? `上次扫描 ${formatServerTime(library.refreshedAt)}` : '还没扫描完'}
          </span>
        </div>
        <div className="share-actions">
          <button className="btn" onClick={scan} disabled={scanning}>
            <RefreshCw size={16} />
            扫描
          </button>
          <button className="btn" onClick={onEdit}>
            <Folder size={16} />
            修改文件夹
          </button>
          <button className="icon-btn" onClick={remove} aria-label="移除">
            <Trash2 size={18} />
          </button>
        </div>
      </div>
      <ul className="path-list">
        {library.importPaths.map((p) => (
          <li key={p}>
            <Folder size={14} /> {relativePath(p, nasRoot, nasNames)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 新建或修改照片库：在 NAS 上选择文件夹 */
function LibraryEditor({ library, nasRoot, onClose }: { library: Library | null; nasRoot: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const nasNames = useNasNames();
  const [name, setName] = useState(library?.name ?? '宝宝照片');
  const [selected, setSelected] = useState<string[]>(library?.importPaths ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (library) await request('PUT', `/api/admin/libraries/${library.id}`, { name, importPaths: selected });
      else await request('POST', '/api/admin/libraries', { name, importPaths: selected });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'immich'] });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      setSaving(false);
    }
  }

  return (
    <Modal
      title={library ? '修改照片库' : '添加照片库'}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted">保存后会立即开始扫描</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || !selected.length || saving} onClick={save}>
            {saving ? '保存中…' : '保存并扫描'}
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span>名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} />
        </label>
        <div className="field">
          <span>已选择的文件夹（会包含所有子文件夹）</span>
          {selected.length ? (
            <div className="chips">
              {selected.map((p) => (
                <span key={p} className="chip chip-accent">
                  {relativePath(p, nasRoot, nasNames)}
                  <button type="button" className="chip-x" onClick={() => setSelected((s) => s.filter((x) => x !== p))} aria-label="移除">
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="muted">在下面勾选要导入的文件夹</p>
          )}
        </div>
        <FolderPicker selected={selected} onToggle={(p) => setSelected((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]))} />
        {error && <div className="error-box">{error}</div>}
      </div>
    </Modal>
  );
}

function FolderPicker({ selected, onToggle }: { selected: string[]; onToggle: (path: string) => void }) {
  const [rel, setRel] = useState('');
  const listing = useQuery({ queryKey: ['admin', 'folders', rel], queryFn: () => get<FolderListing>(`/api/admin/folders?path=${encodeURIComponent(rel)}`) });
  const crumbs = rel ? rel.split('/') : [];
  const nasNames = useNasNames();
  // 已选中某个上级文件夹时，下级自动包含在内
  const coveredBy = (path: string) => selected.find((s) => path !== s && path.startsWith(`${s}/`));

  return (
    <div className="folder-picker">
      <div className="breadcrumb">
        <button type="button" onClick={() => setRel('')}>
          存储
        </button>
        {crumbs.map((c, i) => (
          <span key={i}>
            <ChevronRight size={14} />
            <button type="button" onClick={() => setRel(crumbs.slice(0, i + 1).join('/'))}>
              {i === 0 ? (nasNames.get(c) ?? c) : c}
            </button>
          </span>
        ))}
      </div>
      {listing.isPending ? (
        <Spinner />
      ) : listing.isError ? (
        <ErrorBox error={listing.error} />
      ) : !listing.data.folders.length ? (
        <p className="muted folder-empty">这里没有子文件夹</p>
      ) : (
        <ul className="folder-list">
          {listing.data.folders.map((f) => {
            const parent = coveredBy(f.path);
            return (
              <li key={f.path}>
                <label>
                  <input type="checkbox" checked={selected.includes(f.path) || !!parent} disabled={!!parent} onChange={() => onToggle(f.path)} />
                  <Folder size={16} />
                </label>
                <button type="button" className="folder-name" onClick={() => setRel(listing.data.relative ? `${listing.data.relative}/${f.name}` : f.name)}>
                  {f.label}
                  <ChevronRight size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function QueueSection({ queues }: { queues: Queue[] }) {
  const queryClient = useQueryClient();
  const busy = queues.filter((q) => q.active + q.waiting > 0);
  const [running, setRunning] = useState<string | null>(null);
  const DONE: Record<string, string> = { pause: '已暂停', resume: '已继续', start: '已开始补跑', 'clear-failed': '已清除失败记录' };
  async function run(q: Queue, command: string) {
    setRunning(q.name);
    await attempt(() => request('POST', `/api/admin/immich/queues/${q.name}`, { command }), `${q.label}：${DONE[command]}`);
    setRunning(null);
    await queryClient.invalidateQueries({ queryKey: ['admin', 'immich'] });
  }
  return (
    <section>
      <div className="section-actions">
        <div>
          <h2>后台处理</h2>
          <p className="muted">{busy.length ? `正在处理：${busy.map((q) => q.label).join('、')}` : '全部处理完了。新照片导入后会自动开始。'}</p>
        </div>
      </div>
      <div className="card queue-table">
        {queues.map((q) => (
          <div key={q.name} className="queue-row">
            <span className="queue-name">{q.label}</span>
            <span className="queue-counts">
              {q.isPaused ? <span className="badge">已暂停</span> : q.active > 0 ? <span className="badge badge-run">进行中</span> : null}
              {q.waiting > 0 && <span>等待 {q.waiting.toLocaleString()}</span>}
              {q.failed > 0 && <span className="text-danger">失败 {q.failed.toLocaleString()}</span>}
              {q.active + q.waiting === 0 && !q.failed && !q.isPaused && <span className="muted">空闲</span>}
            </span>
            <span className="queue-actions">
              {/* 手机上看不到鼠标悬停的提示，按钮上直接写字 */}
              {q.isPaused ? (
                <button className="btn btn-small" disabled={running === q.name} onClick={() => run(q, 'resume')}>
                  <Play size={14} /> 继续
                </button>
              ) : (
                <button className="btn btn-small" disabled={running === q.name || q.active + q.waiting === 0} onClick={() => run(q, 'pause')}>
                  <Pause size={14} /> 暂停
                </button>
              )}
              <button className="btn btn-small" disabled={running === q.name} onClick={() => run(q, 'start')} title="处理还没处理过的文件">
                <RefreshCw size={14} /> 补跑
              </button>
              {q.failed > 0 && (
                <button className="btn btn-small" disabled={running === q.name} onClick={() => run(q, 'clear-failed')}>
                  <RotateCcw size={14} /> 清除失败
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
