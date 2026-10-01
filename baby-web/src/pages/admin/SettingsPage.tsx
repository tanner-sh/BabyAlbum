import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { get, request, type ImmichSettings } from '../../api';
import { ErrorBox, Spinner, Toggle } from '../../components/ui';

// Immich 的系统设置：只开放常用的几项，用中文说明。保存后立即生效，不需要重启或改 Docker 配置

const TRANSCODE: { value: ImmichSettings['transcode']; label: string; hint: string }[] = [
  { value: 'disabled', label: '不转码（推荐）', hint: '浏览器直接播放原视频。大多数新设备都能播放 HEVC；部分旧电脑、安卓手机、微信内置浏览器可能播不了' },
  { value: 'required', label: '只转码浏览器不支持的格式', hint: '注意：Immich 只把 H.264 当作“支持”，HEVC 视频也会被转码' },
  { value: 'optimal', label: '转码分辨率高于目标的视频', hint: '适合要通过外网给家人看视频，4K 视频会生成一份小的' },
  { value: 'all', label: '全部转码', hint: '最兼容，但最慢、最占空间' },
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
