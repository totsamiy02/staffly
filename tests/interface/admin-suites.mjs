const legacySuites = {
  'service-ui': 'service', 'polish-ui': 'polish', 'workflow-ui': 'workflow',
  'review-fixes': 'review-fixes', management: 'management', operations: 'operations',
  'admin-layout': 'layout',
}
export const adminSuites = Object.freeze(['monitoring', 'management', 'operations', 'workflow', 'polish', 'review-fixes', 'service', 'layout'])

// A typo must fail instead of silently running the default monitoring suite.
export function resolveAdminSuite(options) {
  const explicit = options['admin-suite']
  if (explicit !== undefined && !adminSuites.includes(explicit)) throw new Error('Unknown --admin-suite: ' + explicit)
  const requested = new Set(explicit === undefined ? [] : [explicit])
  for (const [flag, suite] of Object.entries(legacySuites)) {
    if (options[flag] === undefined) continue
    if (!['true', 'false'].includes(options[flag])) throw new Error('--' + flag + ' must be true or false')
    if (options[flag] === 'true') requested.add(suite)
  }
  if (requested.size > 1) throw new Error('Choose one admin suite per run')
  return [...requested][0] ?? 'monitoring'
}
