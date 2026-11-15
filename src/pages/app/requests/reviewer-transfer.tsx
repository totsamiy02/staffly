import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../../app/auth/auth-context.tsx';
import { invalidateOrganizationWork } from '../../../app/live-query.ts';
import type { StaffRequest } from '../../../app/requests/types.ts';
import Select from '../../../component/ui/select/select.tsx';
import RequestErrorMessage from '../../../component/ui/request-error-message.tsx';
import { useToast } from '../../../component/ui/toast/toast-context.ts';
import './reviewer-transfer.scss';

export default function ReviewerTransfer({ request, onTransferred }: { request: StaffRequest; onTransferred: () => void }) {
  const [open, setOpen] = useState(false);
  if (!request.canTransferReview) return null;
  return <section className="reviewer-transfer">
    {open ? <TransferForm key={request.updatedAt} request={request} onClose={() => setOpen(false)} onTransferred={onTransferred} />
      : <button className="app-secondary" type="button" onClick={() => setOpen(true)}>Передать другому согласующему</button>}
  </section>;
}

function TransferForm({ request, onClose, onTransferred }: { request: StaffRequest; onClose: () => void; onTransferred: () => void }) {
  const { apiRequest } = useAuth();
  const cache = useQueryClient();
  const toast = useToast();
  const [memberId, setMemberId] = useState('');
  const [comment, setComment] = useState('');
  const root = `/organizations/${request.organizationId}/requests/${request.id}`;
  const candidates = useQuery({
    queryKey: ['request-reviewers', request.organizationId, request.id, request.updatedAt],
    queryFn: () => apiRequest<{ members: Array<{ id: string; name: string }> }>(root + '/reviewer-candidates'),
    staleTime: 0,
  });
  const mutation = useMutation({
    mutationFn: () => apiRequest(root + '/transfer-review', {
      method: 'POST', body: { memberId, comment, updatedAt: request.updatedAt },
    }),
    onSuccess: async () => {
      // A former reviewer can lose read access after handing off a private route.
      // Leave the card before refetching the new permissions and queue.
      onTransferred();
      toast('Согласование передано.', 'success');
      await invalidateOrganizationWork(cache, request.organizationId);
    },
    onError: () => { void candidates.refetch(); },
  });
  return <form className="reviewer-transfer__form" aria-label="Передача согласования" onSubmit={event => { event.preventDefault(); mutation.mutate(); }}>
    <header><h3>Передать согласование</h3><p>Изменится только текущий этап. Срок и следующие этапы сохранятся.</p></header>
    {candidates.isPending ? <p role="status">Загружаем доступных согласующих…</p>
      : candidates.isError ? <div role="alert"><RequestErrorMessage error={candidates.error} /><button type="button" className="app-secondary" onClick={() => void candidates.refetch()}>Повторить</button></div>
        : !candidates.data?.members.length ? <p>Нет другого доступного согласующего с нужными правами в этой точке.</p>
          : <>
            <label><span>Новый согласующий</span><Select searchable required aria-label="Новый согласующий" value={memberId} disabled={mutation.isPending} onChange={event => setMemberId(event.target.value)}>
              <option value="">Выберите сотрудника</option>
              {candidates.data.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
            </Select></label>
            <label><span>Комментарий <small>необязательно</small></span><textarea rows={2} value={comment} maxLength={500} disabled={mutation.isPending} onChange={event => setComment(event.target.value)} placeholder="Например, коллега сейчас ведёт этот вопрос" /></label>
          </>}
    {mutation.isError && <div role="alert"><RequestErrorMessage error={mutation.error} /></div>}
    <footer><button type="button" className="app-secondary" disabled={mutation.isPending} onClick={onClose}>Отмена</button>
      {!!candidates.data?.members.length && <button className="app-primary" disabled={!memberId || mutation.isPending}>{mutation.isPending ? 'Передаём…' : 'Передать согласование'}</button>}
    </footer>
  </form>;
}
