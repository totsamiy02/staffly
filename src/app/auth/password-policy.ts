import { passwordLength, passwordRuleError } from './password-rules.ts'

export const passwordRequirements = [
  { label: '15–128 символов · можно слова и пробелы', test: (value: string) => passwordLength(value) >= 15 && passwordLength(value) <= 128 },
]

export function passwordValidationError(value: string) {
  return passwordRuleError(value)
}
