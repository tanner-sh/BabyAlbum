import { Check, Copy, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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

const openModals: object[] = [];

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
  useEffect(() => {
    // 弹窗可以叠起来（比如人物里再点开对比照片），Esc 只关最上面那个
    const token = {};
    openModals.push(token);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && openModals.at(-1) === token && closeRef.current();
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      window.removeEventListener('keydown', onKey);
      openModals.splice(openModals.indexOf(token), 1);
      if (!openModals.length) document.body.classList.remove('no-scroll');
    };
  }, []);

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
