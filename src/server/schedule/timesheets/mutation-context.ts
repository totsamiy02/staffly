import { AsyncLocalStorage } from 'node:async_hooks';
// Request-local identity is copied to a transaction-local PostgreSQL setting.
// Never keep an actor or correction reason on a pooled connection/session.
export const timesheetMutationContext = new AsyncLocalStorage<{
  userId: string;
  reason: string;
}>();
