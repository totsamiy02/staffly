export function normalizeRussianPhone(value: string) {
  const digits = value.replace(/\D/g, '').slice(0, 11)
  if (digits.length !== 11 || (digits[0] !== '7' && digits[0] !== '8')) return ''
  return `+7${digits.slice(1)}`
}

export function formatRussianPhone(value: string) {
  let digits = value.replace(/\D/g, '')
  if (!digits) return ''
  if (digits[0] === '8') digits = `7${digits.slice(1)}`
  if (digits[0] !== '7') return ''
  digits = digits.slice(0, 11)
  const body = digits.slice(1)
  let result = '+7'
  if (body.length) result += ` (${body.slice(0, 3)}`
  if (body.length >= 3) result += ')'
  if (body.length > 3) result += ` ${body.slice(3, 6)}`
  if (body.length > 6) result += `-${body.slice(6, 8)}`
  if (body.length > 8) result += `-${body.slice(8, 10)}`
  return result
}

export function isCompleteRussianPhone(value: string) {
  return !value.trim() || Boolean(normalizeRussianPhone(value))
}
