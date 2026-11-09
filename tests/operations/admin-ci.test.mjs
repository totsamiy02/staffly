import assert from 'node:assert/strict'
import { it } from 'node:test'
import { resolveAdminSuite } from '../interface/admin-suites.mjs'

it('refuses misspelled or conflicting admin suites instead of reporting another suite green', () => {
  assert.throws(() => resolveAdminSuite({ 'admin-suite': 'servcie' }), /Unknown/)
  assert.throws(() => resolveAdminSuite({ 'admin-suite': 'service', management: 'true' }), /one admin suite/)
  assert.throws(() => resolveAdminSuite({ 'service-ui': 'yes' }), /true or false/)
})
it('preserves existing admin test commands and an explicit monitoring selection', () => {
  for (const [flag, suite] of Object.entries({ 'service-ui': 'service', 'polish-ui': 'polish', 'workflow-ui': 'workflow', 'review-fixes': 'review-fixes', management: 'management', operations: 'operations', 'admin-layout': 'layout' })) {
    assert.equal(resolveAdminSuite({ [flag]: 'true' }), suite)
    assert.equal(resolveAdminSuite({ [flag]: 'true', 'admin-suite': suite }), suite)
  }
  assert.equal(resolveAdminSuite({}), 'monitoring')
  assert.equal(resolveAdminSuite({ 'service-ui': 'false', 'admin-suite': 'monitoring' }), 'monitoring')
})
