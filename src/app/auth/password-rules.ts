// Shared by every password-creation form and the server. Existing passwords keep working.
export const MIN_PASSWORD_LENGTH = 15
export const MAX_PASSWORD_LENGTH = 128
export const passwordLength = (value: string) => Array.from(value).length
export function passwordRuleError(value: string) {
  const length = passwordLength(value)
  if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) return 'Используйте от 15 до 128 символов. Можно слова, пробелы и любые буквы.'
  if (!value.trim() || /^(.)\1+$/us.test(value)) return 'Выберите менее предсказуемый пароль.'
  return ''
}
