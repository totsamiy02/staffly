export const demoCards = ['4242424242424242', '5555555555554444', '2200000000000004'] as const
export const cardNumber = (value: string) => value.replace(/\D/g, '').slice(0, 16)
export const cardBrand = (value: string) => value.startsWith('4') ? 'VISA' : /^5[1-5]/.test(value) ? 'Mastercard' : value.startsWith('220') ? 'МИР' : ''
export function validateDemoCard(data: { number: string; expiry: string; cvc: string; holder: string; email: string; confirm: boolean }, now = new Date()) {
  const errors: Record<string, string> = {}, digits = cardNumber(data.number)
  let sum = 0
  for (let index = 0; index < digits.length; index++) { let digit = +digits[digits.length - 1 - index]; if (index % 2) { digit *= 2; if (digit > 9) digit -= 9 }; sum += digit }
  if (digits.length !== 16 || sum % 10) errors.number = 'Проверьте номер карты.'
  else if (!(demoCards as readonly string[]).includes(digits)) errors.number = 'В тестовом режиме используйте карту 4242 4242 4242 4242.'
  const match = /^(\d{2})\s*\/\s*(\d{2})$/.exec(data.expiry), month = Number(match?.[1]), year = 2000 + Number(match?.[2])
  if (!match || month < 1 || month > 12) errors.expiry = 'Укажите срок в формате ММ / ГГ.'
  else if (year < now.getFullYear() || year === now.getFullYear() && month < now.getMonth() + 1) errors.expiry = 'Срок действия истёк.'
  if (!/^\d{3}$/.test(data.cvc)) errors.cvc = 'Укажите 3 цифры.'
  if (!/^[A-Za-z][A-Za-z '-]{1,79}$/.test(data.holder.trim())) errors.holder = 'Укажите имя латиницей.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) || data.email.length > 254) errors.email = 'Укажите корректный email.'
  if (!data.confirm) errors.confirm = 'Подтвердите организацию и тестовую активацию.'
  return errors
}
