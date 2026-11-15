import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/auth-context.tsx';
import { liveQueryOptions } from '../../live-query.ts';
import type { TimesheetData } from './types.ts';
export function useTimesheet(organizationId: string, month: string, enabled: boolean, eventPage = 1) {
  const { apiRequest, locationId } = useAuth();
  return useQuery({
    ...liveQueryOptions, queryKey: ['timesheet', organizationId, locationId, month, eventPage],
    queryFn: () => apiRequest<TimesheetData>(`/organizations/${organizationId}/schedule/timesheets/${month}?eventPage=${eventPage}`), enabled
  });
}
