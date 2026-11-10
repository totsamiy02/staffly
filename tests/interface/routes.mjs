import { guideCollections } from '../../src/pages/guide/content/index.ts'

export function interfaceRoutes(fixture) {
  const root = `/app/organizations/${fixture.org.id}`
  return [
    ['home', '/', false], ['auth', '/auth', false], ['register', '/auth?mode=register', false], ['verify', '/verify-email', false], ['forgot', '/forgot-password', false], ['reset', '/reset-password', false], ['yandex', '/auth/yandex', false],
    ['contacts', '/contacts', false], ['privacy', '/privacy-policy', false], ['consent', '/personal-data-consent', false], ['terms', '/terms', false], ['offer', '/offer', false], ['not-found', '/not-a-real-page', false],
    ['guide', '/guide', false], ['guide-category', '/guide/category/management', false], ['guide-article', '/guide/profile', false], ['guide-search', '/guide?q=смена', false],
    ...guideCollections.filter(c => c.id !== 'management').map(c => [`guide-category-${c.id}`, '/guide/category/' + c.id, false]),
    ['guide-search-empty', '/guide?q=несуществующийзапрос123', false], ['guide-member-filter', '/guide?audience=member', false],
    ['organizations', '/app', true], ['create-organization', '/app/organizations/new', true],
    ...['profile', 'security', 'documents', 'notifications'].map(section => [`account-${section}`, `/app/settings?section=${section}`, true]),
    ['dashboard', root, true], ['employees', root + '/employees', true], ['schedule', root + '/schedule', true], ['demand', root + '/schedule/demand', true], ['drafts', root + '/schedule/drafts', true], ['draft-detail', root + '/schedule/drafts/' + fixture.draft.id, true], ['schedule-history', root + '/schedule/history', true], ['statistics', root + '/schedule/statistics', true], ['work-time', root + '/schedule/work-time', true],
    ...['mine', 'incoming', 'history', 'staffing', 'vacations', 'offers'].map(tab => [`requests-${tab}`, root + '/requests?tab=' + tab, true]),
    ['events', root + '/events', true], ['documents', root + '/documents', true],
    ...['profile', 'locations', 'schedule', 'requests', 'roles', 'access', 'subscription'].map(section => [`settings-${section}`, root + '/settings?section=' + section, true]),
    ['controls', '/tests/interface/controls.html', true],
  ]
}
