import { Check, Copy, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { type Baby } from '../api';

export function Spinner({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner-dot" />
      {label}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return <div className="error-box">{error instanceof Error ? error.message : '出错了，请稍后再试'}</div>;
}

export function Avatar({ baby, size = 56 }: { baby: Pick<Baby, 'name' | 'thumbnailUrl'>; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      <span className="avatar-fallback">{baby.name.slice(-1)}</span>
      <img src={baby.thumbnailUrl} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = 'none')} />
    </span>
  );
}

type Layer = { id: number; close: () => void; history: boolean };
const layers: Layer[] = [];
// 从当前时间开始编号：刷新页面后浏览器历史里还留着刷新前的层号，新的层号必须比它们大，
// 不然按返回键时会被当成“已经退掉的层”，关不掉
let nextLayerId = Date.now();
const LAYER_KEY = 'babyAlbumLayer';
/** 被返回键关掉的层：它在历史记录里的那一条已经没了，关闭时不用再后退 */
const closedByBack = new Set<number>();
const historyLayer = () => (window.history.state?.[LAYER_KEY] as number | undefined) ?? 0;

/** 点关闭按钮关掉、要从历史记录里退掉的层（同时关掉的几层一起退） */
const pendingBack = new Set<number>();
/** 自己退历史记录时，浏览器会把滚动位置恢复成打开弹窗前的；记下当前位置，退完再滚回来 */
let keepScroll: number | null = null;

function flushBack() {
  // StrictMode 下会卸载再重新挂载，重新挂载的不算关掉
  const ids = [...pendingBack].filter((id) => !layers.some((l) => l.id === id));
  pendingBack.clear();
  const current = historyLayer();
  // 历史记录已经不在这些层上（关闭时跳到了别的页面）就不用管
  if (!ids.includes(current)) return;
  const top = Math.max(0, ...layers.filter((l) => l.history).map((l) => l.id));
  const n = ids.filter((id) => id > top && id <= current).length;
  if (!n) return;
  const y = window.scrollY;
  keepScroll = y;
  // 万一没收到 popstate，别影响之后用户自己按返回键
  setTimeout(() => keepScroll === y && (keepScroll = null), 1000);
  window.history.go(-n);
}

// 手机的返回键、侧滑返回：只关掉最上面的弹窗、大图，不离开当前页面
window.addEventListener('popstate', () => {
  if (keepScroll !== null) {
    const y = keepScroll;
    keepScroll = null;
    window.scrollTo(0, y);
    requestAnimationFrame(() => window.scrollTo(0, y));
  }
  const current = historyLayer();
  for (const l of [...layers].reverse()) {
    if (!l.history || l.id <= current) continue;
    closedByBack.add(l.id);
    l.close();
  }
});

/**
 * 叠起来的弹窗、大图（比如人物弹窗里再点开照片）：只有最上面一层响应 Esc，
 * 全部关掉后页面才恢复滚动。打开时在浏览器历史里记一条，按返回键就是关掉这一层。
 * 返回“当前是不是最上面一层”
 */
export function useLayer(onClose: () => void, { history = true }: { history?: boolean } = {}) {
  const [id] = useState(() => nextLayerId++);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const layer: Layer = { id, close: () => closeRef.current(), history };
    layers.push(layer);
    document.body.classList.add('no-scroll');
    if (history && historyLayer() !== id) window.history.pushState({ ...window.history.state, [LAYER_KEY]: id }, '');
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      if (!layers.length) document.body.classList.remove('no-scroll');
      if (!history || closedByBack.delete(id)) return;
      // 点关闭按钮关掉的：把记的那一条退掉
      if (!pendingBack.size) setTimeout(flushBack);
      pendingBack.add(id);
    };
  }, [id, history]);
  return useCallback(() => layers.at(-1)?.id === id, [id]);
}

// ---------------------------------------------------------------- 提示条

type ToastItem = { id: number; text: string; kind: 'ok' | 'error' };
let toasts: ToastItem[] = [];
let nextToastId = 1;
const toastListeners = new Set<() => void>();
const emitToasts = () => toastListeners.forEach((l) => l());

/** 页面底部的提示，几秒后自动消失。操作成功、失败的反馈都用它 */
export function toast(text: string, kind: 'ok' | 'error' = 'ok') {
  const id = nextToastId++;
  toasts = [...toasts, { id, text, kind }];
  emitToasts();
  setTimeout(
    () => {
      toasts = toasts.filter((t) => t.id !== id);
      emitToasts();
    },
    kind === 'error' ? 6000 : 3000,
  );
}

export const errorMessage = (e: unknown, fallback = '操作失败，请稍后再试') => (e instanceof Error && e.message ? e.message : fallback);

/** 执行一个操作，失败时弹出提示；返回是否成功 */
export async function attempt(fn: () => Promise<unknown>, okText?: string): Promise<boolean> {
  try {
    await fn();
    if (okText) toast(okText);
    return true;
  } catch (e) {
    toast(errorMessage(e), 'error');
    return false;
  }
}

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => {
      toastListeners.add(l);
      return () => toastListeners.delete(l);
    },
    () => toasts,
  );
  if (!list.length) return null;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- 确认框

type ConfirmRequest = {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** 点确定后执行；失败时确认框不关，显示原因 */
  action: () => Promise<unknown>;
};

/** 页面里的确认框（代替浏览器自带的 confirm）：确定后显示处理中，失败了告诉用户原因。返回 [打开确认框, 要渲染的确认框] */
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const dialog = request && <ConfirmDialog {...request} onClose={() => setRequest(null)} />;
  return [setRequest as (r: ConfirmRequest) => void, dialog] as const;
}

function ConfirmDialog({ title, message, confirmLabel = '确定', danger, action, onClose }: ConfirmRequest & { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={title}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={run} disabled={busy}>
            {busy ? '处理中…' : confirmLabel}
          </button>
        </>
      }
    >
      {message && <div className="confirm-message">{message}</div>}
      {error && <div className="error-box">{error}</div>}
    </Modal>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const isTop = useLayer(() => closeRef.current());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && isTop() && closeRef.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isTop]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: ReactNode }[];
}) {
  return (
    <nav className="tabs" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          className={`tab ${value === o.value ? 'active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </nav>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`toggle-row ${disabled ? 'disabled' : ''}`}>
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <span className="muted">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" className="toggle" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function CopyButton({ text, label = '复制链接' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => prompt('复制这个链接', text));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
      {copied ? '已复制' : label}
    </button>
  );
}

/** 选择能看哪些宝宝：null 表示全部 */
export function BabyAccessPicker({ babies, value, onChange }: { babies: Baby[]; value: number[] | null; onChange: (v: number[] | null) => void }) {
  return (
    <div className="chips">
      <button type="button" className={`chip ${value === null ? 'chip-accent' : ''}`} onClick={() => onChange(null)}>
        全部宝宝
      </button>
      {babies.map((b) => {
        const on = value?.includes(b.id) ?? false;
        return (
          <button
            key={b.id}
            type="button"
            className={`chip ${on ? 'chip-accent' : ''}`}
            onClick={() => {
              const next = on ? (value ?? []).filter((x) => x !== b.id) : [...(value ?? []), b.id];
              onChange(next.length ? next : null);
            }}
          >
            只看{b.name}
          </button>
        );
      })}
    </div>
  );
}
