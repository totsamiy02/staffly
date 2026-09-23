export const passwordRequirements = [
  { label: '10–128 символов', test: (value: string) => value.length >= 10 && value.length <= 128 },
  { label: 'строчная буква', test: (value: string) => /[a-zа-яё]/u.test(value) },
  { label: 'заглавная буква', test: (value: string) => /[A-ZА-ЯЁ]/u.test(value) },
  { label: 'цифра', test: (value: string) => /\d/.test(value) },
  { label: 'специальный символ', test: (value: string) => /[^\p{L}\p{N}\s]/u.test(value) },
  { label: 'без пробелов', test: (value: string) => !/\s/u.test(value) },
]

export function passwordValidationError(value: string) {
  return passwordRequirements.every((requirement) => requirement.test(value)) ? '' : 'Пароль не соответствует требованиям безопасности.'
}
