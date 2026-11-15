import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/auth-context.tsx';
import { liveQueryOptions } from '../live-query.ts';
import { useToast } from '../../component/ui/toast/toast-context.ts';
import type { EmailCategory, EmailPreferences } from './email-preferences.ts';

export type EmailSettings = EmailPreferences & { availableCategories: EmailCategory[] };
type Change = { enabled?: boolean; categories?: Partial<Record<EmailCategory, boolean>>; confirmDisable?: boolean };
export function useEmailPreferences(onSaved?: () => void) {
  const { user, apiRequest } = useAuth(), cache = useQueryClient(), toast = useToast();
  const key = ['email-preferences', user?.id];
  const query = useQuery({ ...liveQueryOptions, queryKey: key, queryFn: () => apiRequest<EmailSettings>('/profile/email-preferences'), enabled: !!user, staleTime: 60_000 });
  const mutation = useMutation({ mutationFn: (change: Change) => apiRequest<EmailSettings>('/profile/email-preferences', {
    method: 'PATCH', body: { ...change, revision: cache.getQueryData<EmailSettings>(key)?.revision ?? 0 },
  }), onSuccess: (settings, change) => {
    cache.setQueryData(key, settings); onSaved?.();
    toast(change.enabled === true ? 'Рабочие письма включены. Ваш выбор категорий сохранён.' : change.enabled === false ? 'Рабочие письма отключены.' : 'Настройки уведомлений сохранены.', 'success');
  }, onError: (error) => { toast(error instanceof Error ? error.message : 'Не удалось сохранить настройки уведомлений.', 'error'); void query.refetch(); } });
  return { query, mutation };
}
