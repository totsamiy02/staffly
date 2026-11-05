import { ApiError } from '../api-error.ts'

// Applies to direct security mail in every API replica as well as the outbox.
// An environment change takes effect after the sending processes are restarted.
export const emailDeliveryPaused = () => process.env.EMAIL_DELIVERY_PAUSED === 'true'
export class EmailDeliveryPausedError extends ApiError {
  constructor() { super(503, 'EMAIL_DELIVERY_PAUSED', 'Отправка писем временно приостановлена. Повторите позже.') }
}
