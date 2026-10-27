export type LoginMethods = { hasPassword: boolean; passwordSetupReady: boolean; emailChangeReady: boolean; yandex: { enabled: boolean; connected: boolean; email: string | null } }
export type YandexPending = { mode: 'register' | 'connect'; email: string; firstName: string | null; lastName: string | null; canConfirmPassword: boolean; returnTo: string }
export function yandexMessage(marker: string | null) {
  switch (marker) {
    case 'cancelled': return 'Вход через Яндекс отменён. Можно попробовать снова.'
    case 'expired': return 'Вход через Яндекс истёк. Начните ещё раз.'
    case 'email-required': return 'Яндекс не передал почту. Разрешите доступ к адресу электронной почты и повторите вход.'
    case 'already-linked': return 'Этот аккаунт Яндекса уже подключён или у вас подключён другой аккаунт Яндекса.'
    case 'account-unavailable': return 'Аккаунт Staffly недоступен. Используйте другой аккаунт.'
    case 'wrong-account': return 'Выберите тот аккаунт Яндекса, который уже подключён к Staffly.'
    case 'security-changed': return 'Настройки безопасности изменились. Подтвердите действие ещё раз.'
    case 'failed': return 'Не удалось завершить вход через Яндекс. Попробуйте ещё раз.'
    default: return ''
  }
}
