import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { get, request, type AppSettings, type ImmichSettings } from '../../api';
import { ErrorBox, Spinner, Toggle, useConfirm } from '../../components/ui';

// Immich 的系统设置：只开放常用的几项，用中文说明。保存后立即生效，不需要重启或改 Docker 配置

const TRANSCODE: { value: ImmichSettings['transcode']; label: string; hint: string }[] = [
  { value: 'disabled', label: '不转码（推荐）', hint: '浏览器直接播放原视频。大多数新设备都能播放 HEVC；部分旧电脑、安卓手机、微信内置浏览器可能播不了' },
  { value: 'required', label: '只转码浏览器不支持的格式', hint: '注意：Immich 只把 H.264 当作“支持”，HEVC 视频也会被转码' },
  { value: 'optimal', label: '转码分辨率高于目标的视频', hint: '适合要通过外网给家人看视频，4K 视频会生成一份小的' },
  { value: 'all', label: '全部转码', hint: '最兼容，但最慢、最占空间' },
];

const CLIP_MODELS = [
  { value: 'nllb-clip-base-siglip__v1', label: '多语言（推荐）', hint: '能用中文搜索，体积适中' },
  { value: 'XLM-Roberta-Large-Vit-B-16Plus', label: '多语言·大', hint: '中文搜索更准一些，但更占内存、更慢' },
  { value: 'ViT-B-32__openai', label: '仅英文', hint: 'Immich 的默认模型，只能用英文搜索（beach、cake）' },
];

const CONCURRENCY_LABELS: Record<keyof ImmichSettings['concurrency'], string> = {
  library: '扫描文件夹',
  metadataExtraction: '读取拍摄信息',
  thumbnailGeneration: '生成缩略图',
  faceDetection: '检测人脸',
  smartSearch: '语义搜索索引',
  videoConversion: '视频转码',
};

const CRON_PRESETS = [
  { value: '0 0 * * *', label: '每天 0 点' },
  { value: '0 02 * * *', label: '每天凌晨 2 点' },
  { value: '0 3 * * *', label: '每天凌晨 3 点' },
  { value: '0 */6 * * *', label: '每 6 小时' },
  { value: '0 * * * *', label: '每小时' },
];

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card settings-section">
      <h3>{title}</h3>
      {hint && <p className="muted">{hint}</p>}
      {children}
    </section>
  );
}

function CronPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const preset = CRON_PRESETS.find((p) => p.value === value);
  return (
    <div className="chips">
      {CRON_PRESETS.map((p) => (
        <button key={p.value} type="button" className={`chip ${value === p.value ? 'chip-accent' : ''}`} onClick={() => onChange(p.value)}>
          {p.label}
        </button>
      ))}
      {!preset && <span className="chip chip-accent">自定义：{value}</span>}
    </div>
  );
}

const MAP_TILES: { value: AppSettings['mapTiles']; label: string; hint: string }[] = [
  { value: 'osm', label: 'OpenStreetMap（默认）', hint: '国际通用的开源地图；在国内加载可能慢一些' },
  { value: 'tianditu', label: '天地图', hint: '国家测绘地理信息局的官方地图，中文标注、国内加载快。需要在天地图官网免费申请 Key' },
  { value: 'amap', label: '高德地图', hint: '国内加载快、中文标注，照片坐标会自动换算。用的是高德网页地图的瓦片地址，不是开放接口，可能随时失效；使用时请遵守高德的服务条款' },
];

/** 在浏览器里加载一块天地图的瓦片，验证 Key（天地图按网站域名限制浏览器端 Key，只能在浏览器里验证） */
function testTiandituKey(key: string) {
  return new Promise<boolean>((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(false), 10_000);
    img.onload = () => {
      clearTimeout(timer);
      resolve(true);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    img.src = `https://t0.tianditu.gov.cn/DataServer?T=vec_w&x=0&y=0&l=1&tk=${encodeURIComponent(key)}&_=${Date.now()}`;
  });
}

/** 宝宝相册自己的设置（和 Immich 无关），改了马上保存 */
function AppSettingsSection() {
  const queryClient = useQueryClient();
  const app = useQuery({ queryKey: ['admin', 'app-settings'], queryFn: () => get<AppSettings>('/api/admin/app-settings') });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [askKey, setAskKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ask, confirmDialog] = useConfirm();
  if (!app.data) return app.isError ? <ErrorBox error={app.error} /> : null;
  const current = app.data;
  const keyValue = key ?? current.tiandituKey ?? '';

  async function save(patch: Partial<AppSettings>, done?: string) {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      queryClient.setQueryData(['admin', 'app-settings'], await request<AppSettings>('PUT', '/api/admin/app-settings', patch));
      // 地图数据里带着底图设置
      await queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('map') });
      if (done) setMessage(done);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      return false;
    } finally {
      setBusy(false);
    }
  }

  function choose(tiles: AppSettings['mapTiles']) {
    // 天地图要先有 Key：先选中天地图、填 Key，验证通过才真正切换
    if (tiles === 'tianditu' && !current.tiandituKey) {
      setAskKey(true);
      return;
    }
    // 正在填天地图 Key 时点了别的：就是不用天地图了
    setAskKey(false);
    setError(null);
    if (tiles !== current.mapTiles) void save({ mapTiles: tiles });
  }

  async function saveKey() {
    // 天地图的 Key 是小写的，复制时可能带了空格或被改成大写
    const k = keyValue.trim().toLowerCase();
    setError(null);
    setMessage(null);
    setBusy(true);
    const ok = await testTiandituKey(k);
    setBusy(false);
    if (!ok) {
      setError('用这个 Key 加载不了天地图。请检查 Key 是否完整、是不是“浏览器端”类型，以及天地图控制台的白名单里有没有本站的域名');
      return;
    }
    if (await save({ tiandituKey: k, mapTiles: 'tianditu' }, '天地图的 Key 可以用，已经切换到天地图')) {
      setKey(null);
      setAskKey(false);
    }
  }

  function removeKey() {
    ask({
      title: '删除天地图的 Key',
      message: '删除天地图的 Key？正在用天地图的话会换回 OpenStreetMap。',
      confirmLabel: '删除',
      danger: true,
      action: async () => {
        // 失败时抛出去，确认框不关、显示原因（save 自己不抛错）
        if (!(await save({ tiandituKey: null, mapTiles: current.mapTiles === 'tianditu' ? 'osm' : current.mapTiles }, '已删除天地图的 Key'))) throw new Error('删除失败，请稍后再试');
        setKey(null);
      },
    });
  }

  const showKey = askKey || current.mapTiles === 'tianditu' || !!current.tiandituKey;
  // 选中的卡片：正在设置天地图时是天地图（还没真正切换），否则是正在用的
  const selected = askKey ? 'tianditu' : current.mapTiles;

  return (
    <Section title="地图" hint="“搜索 · 地图”里按拍摄地点看照片时用的底图。改了马上生效。">
      {confirmDialog}
      <div className="role-picker">
        {MAP_TILES.map((t) => (
          <button
            key={t.value}
            type="button"
            disabled={busy}
            className={`role-option ${selected === t.value ? 'selected' : ''}`}
            onClick={() => choose(t.value)}
            aria-pressed={selected === t.value}
          >
            <strong>
              {t.label}
              {selected !== current.mapTiles && current.mapTiles === t.value && <span className="chip small in-use">正在使用</span>}
            </strong>
            <span className="muted">{t.hint}</span>
          </button>
        ))}
      </div>
      {showKey && (
        <div className="field tianditu-key">
          <span>天地图 Key</span>
          <div className="inline-fields">
            <input value={keyValue} onChange={(e) => setKey(e.target.value)} placeholder="32 位字母和数字" spellCheck={false} autoComplete="off" autoFocus={askKey} />
            <button className="btn btn-primary" disabled={busy || !keyValue.trim() || keyValue.trim() === current.tiandituKey} onClick={saveKey}>
              {busy ? '验证中…' : '验证并使用'}
            </button>
            {current.tiandituKey && (
              <button className="btn btn-danger-ghost" disabled={busy} onClick={removeKey}>
                删除
              </button>
            )}
          </div>
          {askKey && !current.tiandituKey && (
            <p className="notice-inline">填好 Key、验证通过后就切换到天地图；在这之前还是用{MAP_TILES.find((t) => t.value === current.mapTiles)?.label}。</p>
          )}
          <p className="muted small">
            申请方法：在 <a href="https://console.tianditu.gov.cn/" target="_blank" rel="noreferrer">天地图控制台</a> 注册登录，创建应用时类型选“浏览器端”，
            白名单里填访问宝宝相册用的域名（比如 photos.example.com），把生成的 Key 复制到这里。看地图的人的浏览器会直接用这个 Key 加载地图。
          </p>
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      {message && <div className="success-box">{message}</div>}
    </Section>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const remote = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => get<ImmichSettings>('/api/admin/immich/settings') });
  const [s, setS] = useState<ImmichSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (remote.data) setS(remote.data);
  }, [remote.data]);

  if (remote.isPending || !s) return remote.isError ? <ErrorBox error={remote.error} /> : <Spinner />;

  const set = <K extends keyof ImmichSettings>(key: K, value: ImmichSettings[K]) => {
    setS({ ...s, [key]: value });
    setSaved(false);
  };
  const dirty = JSON.stringify(s) !== JSON.stringify(remote.data);

  async function save() {
    setError(null);
    try {
      const updated = await request<ImmichSettings>('PUT', '/api/admin/immich/settings', s);
      queryClient.setQueryData(['admin', 'settings'], updated);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  }

  return (
    <div className="admin-page settings">
      <AppSettingsSection />
      <Section title="视频" hint="手机和相机拍的视频大多是 HEVC 格式。转码非常耗时间和空间，视频多的话要转好几天。">
        <div className="role-picker">
          {TRANSCODE.map((t) => (
            <button key={t.value} type="button" className={`role-option ${s.transcode === t.value ? 'selected' : ''}`} onClick={() => set('transcode', t.value)}>
              <strong>{t.label}</strong>
              <span className="muted">{t.hint}</span>
            </button>
          ))}
        </div>
        {s.transcode !== 'disabled' && (
          <label className="field">
            <span>转码后的分辨率</span>
            <select value={s.targetResolution} onChange={(e) => set('targetResolution', e.target.value)}>
              {['480', '720', '1080', '1440', '2160', 'original'].map((r) => (
                <option key={r} value={r}>
                  {r === 'original' ? '保持原分辨率' : `${r}p`}
                </option>
              ))}
            </select>
          </label>
        )}
      </Section>

      <Section title="人脸识别与搜索" hint="在 CPU 上运行，首次处理大量照片会比较慢，之后只处理新照片。">
        <Toggle checked={s.machineLearning} onChange={(v) => set('machineLearning', v)} label="启用智能功能" hint="关闭后下面几项都不会运行" />
        <Toggle checked={s.facialRecognition} disabled={!s.machineLearning} onChange={(v) => set('facialRecognition', v)} label="人脸识别" hint="宝宝相册靠它找出有宝宝的照片，必须开启" />
        <Toggle checked={s.smartSearch} disabled={!s.machineLearning} onChange={(v) => set('smartSearch', v)} label="语义搜索" hint="用文字搜照片，比如“生日蛋糕”；查找重复照片也依赖它" />
        {s.smartSearch && s.machineLearning && (
          <div className="field">
            <span>搜索模型</span>
            <div className="role-picker">
              {[...CLIP_MODELS, ...(CLIP_MODELS.some((m) => m.value === remote.data!.clipModel) ? [] : [{ value: remote.data!.clipModel, label: remote.data!.clipModel, hint: '当前使用的模型' }])].map((m) => (
                <button key={m.value} type="button" className={`role-option ${s.clipModel === m.value ? 'selected' : ''}`} onClick={() => set('clipModel', m.value)}>
                  <strong>{m.label}</strong>
                  <span className="muted">{m.hint}</span>
                </button>
              ))}
            </div>
            {s.clipModel !== remote.data!.clipModel && (
              <p className="notice">换模型后，所有照片的搜索索引要用新模型重新算一遍（保存后自动开始，照片多的话要几个小时），算完之前搜索结果不全。</p>
            )}
          </div>
        )}
        <Toggle checked={s.duplicateDetection} disabled={!s.machineLearning || !s.smartSearch} onChange={(v) => set('duplicateDetection', v)} label="查找重复照片" />
        <Toggle checked={s.ocr} disabled={!s.machineLearning} onChange={(v) => set('ocr', v)} label="识别照片里的文字" hint="用不上可以关掉，省时间" />
        <label className="field">
          <span>至少出现几次才算一个人物</span>
          <input type="number" min={1} max={50} value={s.minFaces} onChange={(e) => set('minFaces', Number(e.target.value))} />
        </label>
      </Section>

      <Section title="处理速度" hint="同时处理的数量。调大更快，但会占用更多 CPU，电脑可能变卡。">
        <div className="concurrency-grid">
          {(Object.keys(CONCURRENCY_LABELS) as (keyof ImmichSettings['concurrency'])[]).map((k) => (
            <label key={k} className="field">
              <span>{CONCURRENCY_LABELS[k]}</span>
              <input type="number" min={1} max={32} value={s.concurrency[k]} onChange={(e) => set('concurrency', { ...s.concurrency, [k]: Number(e.target.value) })} />
            </label>
          ))}
        </div>
      </Section>

      <Section title="自动导入新照片" hint="定时扫描照片库里的文件夹，把新照片导入进来。">
        <Toggle checked={s.libraryScan.enabled} onChange={(v) => set('libraryScan', { ...s.libraryScan, enabled: v })} label="定时扫描" />
        {s.libraryScan.enabled && <CronPicker value={s.libraryScan.cronExpression} onChange={(v) => set('libraryScan', { ...s.libraryScan, cronExpression: v })} />}
      </Section>

      <Section title="数据库备份" hint="照片的人物、收藏等信息存在 Immich 的数据库里，定期备份（备份位置在“照片库”页面设置）。">
        <Toggle checked={s.backup.enabled} onChange={(v) => set('backup', { ...s.backup, enabled: v })} label="自动备份" />
        {s.backup.enabled && (
          <>
            <CronPicker value={s.backup.cronExpression} onChange={(v) => set('backup', { ...s.backup, cronExpression: v })} />
            <label className="field">
              <span>保留最近几份</span>
              <input type="number" min={1} max={365} value={s.backup.keepLastAmount} onChange={(e) => set('backup', { ...s.backup, keepLastAmount: Number(e.target.value) })} />
            </label>
          </>
        )}
      </Section>

      <Section title="其他">
        <Toggle checked={s.reverseGeocoding} onChange={(v) => set('reverseGeocoding', v)} label="显示拍摄地点" hint="根据照片的 GPS 显示城市名" />
        <label className="field">
          <span>回收站保留天数</span>
          <input type="number" min={1} max={365} value={s.trashDays} onChange={(e) => set('trashDays', Number(e.target.value))} />
        </label>
      </Section>

      <div className="save-bar">
        {error && <span className="text-danger">{error}</span>}
        {saved && !dirty && <span className="muted">已保存，立即生效</span>}
        <button className="btn btn-primary" disabled={!dirty} onClick={save}>
          保存设置
        </button>
      </div>
    </div>
  );
}
