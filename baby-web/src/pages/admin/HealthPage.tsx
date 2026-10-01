import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, MinusCircle, RefreshCw, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { get, request, type HealthCheck, type HealthReport } from '../../api';
import { ErrorBox, Spinner } from '../../components/ui';

const ICONS = {
  ok: <CheckCircle2 size={20} />,
  warn: <AlertTriangle size={20} />,
  error: <XCircle size={20} />,
  skip: <MinusCircle size={20} />,
};
const ORDER = { error: 0, warn: 1, ok: 2, skip: 3 };

export function useHealth() {
  return useQuery({ queryKey: ['admin', 'health'], queryFn: () => get<HealthReport>('/api/admin/health'), refetchInterval: 5 * 60_000 });
}

/** 系统状态：每 5 分钟自动检查一次，有问题时推送提醒管理员 */
export function HealthPage() {
  const health = useHealth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  async function checkNow() {
    setBusy(true);
    try {
      queryClient.setQueryData(['admin', 'health'], await request<HealthReport>('POST', '/api/admin/health/check'));
    } finally {
      setBusy(false);
    }
  }

  if (health.isPending) return <Spinner label="正在检查…" />;
  if (health.isError) return <ErrorBox error={health.error} />;
  const checks = [...health.data.checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const problems = checks.filter((c) => c.status === 'error' || c.status === 'warn').length;

  return (
    <div className="admin-page">
      <div className="section-actions">
        <div>
          <h2>{problems ? `有 ${problems} 项需要注意` : '一切正常'}</h2>
          <p className="muted">
            每 5 分钟自动检查一次，上次检查：{new Date(health.data.checkedAt).toLocaleString('zh-CN')}。严重的问题会推送提醒管理员（在“我的”里打开提醒）。
          </p>
        </div>
        <button className="btn" disabled={busy} onClick={checkNow}>
          <RefreshCw size={16} className={busy ? 'spin' : ''} />
          现在检查
        </button>
      </div>
      <ul className="health-list">
        {checks.map((c) => (
          <HealthRow key={c.key} check={c} />
        ))}
      </ul>
    </div>
  );
}

function HealthRow({ check }: { check: HealthCheck }) {
  return (
    <li className={`health-row ${check.status}`}>
      <span className="health-icon">{ICONS[check.status]}</span>
      <div>
        <strong>{check.label}</strong>
        <span>{check.message}</span>
        {check.hint && <span className="muted small">{check.hint}</span>}
      </div>
    </li>
  );
}

/** 首页提示（管理员）：系统有严重问题 */
export function HealthBanner() {
  const health = useHealth();
  const errors = health.data?.checks.filter((c) => c.status === 'error') ?? [];
  if (!errors.length) return null;
  return (
    <Link to="/admin/health" className="notice notice-error">
      <XCircle size={18} />
      <span>
        系统有问题：{errors.map((c) => `${c.label}（${c.message}）`).join('；')} →
      </span>
    </Link>
  );
}
