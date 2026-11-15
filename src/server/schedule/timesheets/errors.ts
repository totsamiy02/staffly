// Only fixed SQLSTATE codes are exposed, never raw provider messages or values.
export function timesheetDatabaseError(error: unknown, depth = 0): {
  code: string;
  message: string;
} | null {
  if (!error || typeof error !== 'object' || depth > 6)
    return null;
  const item = error as Record<string, unknown>;
  const code = String(item.originalCode ?? item.code);
  if (code === 'P2601')
    return { code: 'TIMESHEET_LOCKED', message: 'Табель за этот период на проверке или закрыт. Сначала верните его в работу в разделе «Табель».' };
  if (code === 'P2602')
    return { code: 'TIMESHEET_REASON_REQUIRED', message: 'Для исправления ранее закрытого табеля укажите причину изменения.' };
  for (const key of ['meta', 'cause', 'driverAdapterError', 'originalError']) {
    const match = timesheetDatabaseError(item[key], depth + 1);
    if (match)
      return match;
  }
  return null;
}
