export function formatTimeEntry(value: string, complete = false) {
  const raw = value.replace(/[^0-9:]/g, '')
  if (raw.includes(':')) {
    const [hour, minute = ''] = raw.split(':')
    return complete && hour ? hour.slice(0, 2).padStart(2, '0') + ':' + minute.slice(0, 2).padStart(2, '0') : hour.slice(0, 2) + ':' + minute.slice(0, 2)
  }
  const digits = raw.slice(0, 4)
  if (complete && digits) {
    if (digits.length <= 2) return digits.padStart(2, '0') + ':00'
    if (digits.length === 3) return '0' + digits[0] + ':' + digits.slice(1)
  }
  return digits.length > 3 ? digits.slice(0, 2) + ':' + digits.slice(2) : digits
}

