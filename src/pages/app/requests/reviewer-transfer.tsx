import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../../app/auth/auth-context.tsx';
import { invalidateOrganizationWork } from '../../../app/live-query.ts';
import type { StaffRequest } from '../../../app/requests/types.ts';
import Select from '../../../component/ui/select/select.tsx';
import RequestErrorMessage from '../../../component/ui/request-error-message.tsx';
import { useToast } from '../../../component/ui/toast/toast-context.ts';
import './reviewer-transfer.scss';

export default function RequestAssignment({ request, onTransferred }: { request: StaffRequest; onTransferred: () => void }) {
  const [open, setOpen] = useState(false);
  const task = Boolean(request.canAssignTask);
  if (!task && !request.canTransferReview) return null;
  return <section className="reviewer-transfer">
    {open ? <TransferForm key={request.updatedAt} request={request} task={task} onClose={() => setOpen(false)} onTransferred={onTransferred} />
      : <button className="app-secondary" type="button" onClick={() => setOpen(true)}>
        {task ? 'Назначить исполнителя' : 'Передать другому согласующему'}
      </button>}
  </section>;
}

function TransferForm({ request, task, onClose, onTransferred }: {
  request: StaffRequest; task: boolean; onClose: () => void; onTransferred: () => void
}) {
  const { apiRequest, locationId } = useAuth();
  const cache = useQueryClient();
  const toast = useToast();
  const [memberId, setMemberId] = useState('');
  const [comment, setComment] = useState('');
  const root = `/organizations/${request.organizationId}/requests/${request.id}`;
  const action = task ? 'Назначить исполнителя' : 'Передать согласование';
  const person = task ? 'Новый исполнитель' : 'Новый согласующий';
  const candidates = useQuery({
    queryKey: task
      ? ['request', request.organizationId, request.id, locationId, 'task-assignees', request.updatedAt]
      : ['request-reviewers', request.organizationId, request.id, request.updatedAt, locationId],
    queryFn: () => apiRequest<{ members: Array<{ id: string; name: string }> }>(root + (task ? '/task-assignee' : '/reviewer-candidates')),
    staleTime: 0,
  });
  const memberAvailable = candidates.isSuccess && candidates.data.members.some(member => member.id === memberId);
  const mutation = useMutation({
    mutationFn: () => apiRequest(root + (task ? '/task-assignee' : '/transfer-review'), {
      method: 'POST', body: { memberId, updatedAt: request.updatedAt, ...(!task ? { comment } : {}) },
    }),
    onSuccess: async () => {
      // A former reviewer can lose read access after handing off a private route.
      // Leave the card before refetching the new permissions and queue.
      if (task) onClose();
      else onTransferred();
      toast(task ? 'Исполнитель назначен.' : 'Согласование передано.', 'success');
      await invalidateOrganizationWork(cache, request.organizationId);
    },
    onError: () => {
      void candidates.refetch();
      if (task) void cache.invalidateQueries({ queryKey: ['request', request.organizationId, request.id, locationId], exact: true });
    },
  });
  return <form className="reviewer-transfer__form" aria-label={task ? 'Назначение исполнителя' : 'Передача согласования'} onSubmit={event => {
    event.preventDefault();
    if (memberAvailable && !mutation.isPending) mutation.mutate();
  }}>
    <header><h3>{action}</h3><p>{task ? 'У задачи сейчас нет доступного исполнителя. Срок и история сохранятся.' : 'Изменится только текущий этап. Срок и следующие этапы сохранятся.'}</p></header>
    {candidates.isPending ? <p role="status">{task ? 'Загружаем доступных сотрудников…' : 'Загружаем доступных согласующих…'}</p>
      : candidates.isError ? <div role="alert"><RequestErrorMessage error={candidates.error} /><button type="button" className="app-secondary" onClick={() => void candidates.refetch()}>Повторить</button></div>
        : !candidates.data?.members.length ? <p>{task ? 'Нет доступных сотрудников с правом работы с задачами в этой точке.' : 'Нет другого доступного согласующего с нужными правами в этой точке.'}</p>
          : <>
            <label><span>{person}</span><Select searchable required aria-label={person} value={memberId} disabled={mutation.isPending} onChange={event => setMemberId(event.target.value)}>
              <option value="">Выберите сотрудника</option>
              {candidates.data.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
            </Select></label>
            {!task && <label><span>Комментарий <small>необязательно</small></span><textarea rows={2} value={comment} maxLength={500} disabled={mutation.isPending} onChange={event => setComment(event.target.value)} placeholder="Например, коллега сейчас ведёт этот вопрос" /></label>}
          </>}
    {mutation.isError && <div role="alert"><RequestErrorMessage error={mutation.error} /></div>}
    <footer><button type="button" className="app-secondary" disabled={mutation.isPending} onClick={onClose}>Отмена</button>
      {!!candidates.data?.members.length && <button className="app-primary" disabled={!memberAvailable || mutation.isPending}>{mutation.isPending ? 'Сохраняем…' : action}</button>}
    </footer>
  </form>;
}
