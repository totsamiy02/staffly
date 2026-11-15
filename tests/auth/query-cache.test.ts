import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient, isCancelledError } from '@tanstack/react-query';
import { clearSessionQueries } from '../../src/app/auth/query-cache.ts';

test('session changes retain public guide/content but remove every private and unknown cache entry', async () => {
  const client = new QueryClient();
  client.setQueryData(['public-guide-catalog', ''], [{ key: 'guide:published', title: 'Published' }]);
  client.setQueryData(['public-content', 'guide:published'], { body: 'Public instruction' });
  client.setQueryData(['request', 'organization', 'private'], { private: 'request data' });
  client.setQueryData(['private-media', 'avatar'], 'private blob');
  client.setQueryData(['unknown-feature'], { private: 'new query types must be cleared by default' });
  const mutation = client.getMutationCache().build(client, { mutationFn: async (value: string) => value });
  await mutation.execute('private mutation result');
  clearSessionQueries(client);
  assert.deepEqual(client.getQueryData(['public-guide-catalog', '']), [{ key: 'guide:published', title: 'Published' }]);
  assert.deepEqual(client.getQueryData(['public-content', 'guide:published']), { body: 'Public instruction' });
  assert.equal(client.getQueryData(['request', 'organization', 'private']), undefined);
  assert.equal(client.getQueryData(['private-media', 'avatar']), undefined);
  assert.equal(client.getQueryData(['unknown-feature']), undefined);
  assert.equal(client.getMutationCache().getAll().length, 0);
  client.clear();
});

test('session bootstrap cannot abort an in-flight public catalog while private requests are cancelled', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let finishPublic!: (value: string[]) => void;
  let publicAborted = false, privateAborted = false;
  const publicRequest = client.fetchQuery({ queryKey: ['public-guide-catalog', ''], queryFn: ({ signal }) => new Promise<string[]>(resolve => {
    finishPublic = resolve;
    signal.addEventListener('abort', () => { publicAborted = true; });
  }) });
  const privateRequest = client.fetchQuery({ queryKey: ['organization-members', 'private'], queryFn: ({ signal }) => new Promise<void>(() => {
    signal.addEventListener('abort', () => { privateAborted = true; });
  }) });
  const privateCancelled = assert.rejects(privateRequest, isCancelledError);
  clearSessionQueries(client);
  finishPublic(['newly published article']);
  assert.deepEqual(await publicRequest, ['newly published article']);
  await privateCancelled;
  assert.equal(publicAborted, false);
  assert.equal(privateAborted, true);
  assert.deepEqual(client.getQueryData(['public-guide-catalog', '']), ['newly published article']);
  client.clear();
});
