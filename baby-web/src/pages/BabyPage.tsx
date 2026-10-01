import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router';
import { canEdit, request, useBabies, type Baby, type Me, type Sex } from '../api';
import { BabyView } from '../components/BabyView';
import { MergeHint, SexPicker } from '../components/ClaimBaby';
import { DateIssuesBanner } from '../components/DateFix';
import { Avatar, Empty, ErrorBox, Modal, Spinner } from '../components/ui';
import { formatDate } from '../format';

export function BabyPage() {
  const me = useOutletContext<Me>();
  const { id } = useParams();
  const babies = useBabies();
  const [editing, setEditing] = useState(false);

  if (babies.isPending) return <Spinner />;
  if (babies.isError) return <ErrorBox error={babies.error} />;
  const baby = babies.data.find((b) => b.id === Number(id));
  if (!baby) return <Empty title="找不到这个宝宝" />;

  return (
    <>
      <header className="baby-header">
        <Avatar baby={baby} size={64} />
        <div>
          <h1>{baby.name}</h1>
          <p className="baby-age">今天 {baby.ageLabel}</p>
          <p className="muted">{formatDate(baby.birthday)} 出生</p>
        </div>
        {me.role === 'admin' && (
          <button className="icon-btn" onClick={() => setEditing(true)} aria-label="编辑宝宝资料">
            <Pencil size={18} />
          </button>
        )}
      </header>
      {canEdit(me) && <DateIssuesBanner baby={baby} />}
      {me.role === 'admin' && <MergeHint baby={baby} />}
      <BabyView baby={baby} />
      {editing && <EditBabyModal baby={baby} onClose={() => setEditing(false)} />}
    </>
  );
}

function EditBabyModal({ baby, onClose }: { baby: Baby; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(baby.name);
  const [birthday, setBirthday] = useState(baby.birthday);
  const [sex, setSex] = useState<Sex | null>(baby.sex);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    try {
      await request('PATCH', `/api/babies/${baby.id}`, { name, birthday, sex });
      // 生日变了，所有按年龄计算的数据都要重新加载
      await queryClient.invalidateQueries();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  }

  async function remove() {
    if (!confirm(`从宝宝相册中移除${baby.name}？\n只删除宝宝档案和里程碑，照片不受影响。`)) return;
    await request('DELETE', `/api/babies/${baby.id}`);
    await queryClient.invalidateQueries({ queryKey: ['babies'] });
    navigate('/');
  }

  return (
    <Modal
      title="编辑宝宝资料"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-danger-ghost" onClick={remove}>
            <Trash2 size={16} />
            移除
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || !birthday} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span>名字</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} />
        </label>
        <label className="field">
          <span>生日</span>
          <input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />
        </label>
        <div className="field">
          <span>性别（用于和 WHO 生长标准对比）</span>
          <SexPicker value={sex} onChange={setSex} />
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>
    </Modal>
  );
}
