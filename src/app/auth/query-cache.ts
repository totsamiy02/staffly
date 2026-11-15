import type { QueryClient } from '@tanstack/react-query';

export function clearSessionQueries(client: QueryClient) {
  // Both endpoints omit credentials and contain no account/tenant data. Keep
  // their active readers alive while authentication is restored or cleared.
  const publicKeys = new Set(['public-content', 'public-guide-catalog']);
  client.removeQueries({ predicate: query => !publicKeys.has(String(query.queryKey[0])) });
  client.getMutationCache().clear();
}
