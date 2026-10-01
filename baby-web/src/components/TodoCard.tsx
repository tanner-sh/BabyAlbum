import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ListTodo, Users, XCircle, AlertTriangle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { get, type UnnamedPerson } from '../api';
import { useHealth } from '../pages/admin/HealthPage';

const COLLAPSE_KEY = 'baby-album:todo-collapsed';
const loadCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
};

type Todo = { key: string; icon: ReactNode; text: string; to: string; level: 'error' | 'warn' | 'info' };

/** 首页（管理员）：需要处理的事合成一张卡片，可以收起来 */
export function TodoCard() {
  const health = useHealth();
  const unnamed = useQuery({ queryKey: ['admin', 'people', 'unnamed'], queryFn: () => get<UnnamedPerson[]>('/api/admin/people/unnamed'), staleTime: 5 * 60_000 });
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  const todos: Todo[] = [];
  const checks = health.data?.checks ?? [];
  const errors = checks.filter((c) => c.status === 'error');
  const warns = checks.filter((c) => c.status === 'warn');
  if (errors.length) todos.push({ key: 'error', icon: <XCircle size={16} />, text: `系统有问题：${errors.map((c) => c.label).join('、')}`, to: '/admin/health', level: 'error' });
  if (warns.length) todos.push({ key: 'warn', icon: <AlertTriangle size={16} />, text: `${warns.map((c) => c.label).join('、')}需要注意`, to: '/admin/health', level: 'warn' });
  const often = (unnamed.data ?? []).filter((p) => p.withBaby >= 10);
  if (often.length) todos.push({ key: 'family', icon: <Users size={16} />, text: `${often.length} 位常和宝宝一起出现的人还没有名字`, to: '/admin/people', level: 'info' });
  if (!todos.length) return null;

  const toggle = () => {
    setCollapsed(!collapsed);
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '0' : '1');
    } catch {
      // 存不了就只在这次有效
    }
  };

  return (
    <section className={`todo-card ${todos.some((t) => t.level === 'error') ? 'has-error' : ''}`}>
      <button className="todo-head" onClick={toggle} aria-expanded={!collapsed}>
        <ListTodo size={18} />
        <strong>需要处理的事</strong>
        <span className="todo-count">{todos.length}</span>
        {collapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
      </button>
      {!collapsed && (
        <ul>
          {todos.map((t) => (
            <li key={t.key} className={t.level}>
              <Link to={t.to}>
                {t.icon}
                <span>{t.text}</span>
                <ChevronRight size={16} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
