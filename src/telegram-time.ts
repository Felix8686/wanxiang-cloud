export function formatLocalDateTimeAt(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).format(date).replace(' ', 'T');
  } catch {
    return date.toISOString();
  }
}

export function telegramMessageDateToDate(unixSeconds: number | undefined): Date | null {
  if (!Number.isFinite(unixSeconds) || !unixSeconds || unixSeconds <= 0) return null;
  const date = new Date(unixSeconds * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function resolveTelegramReferenceTime(
  unixSeconds: number | undefined,
  timeZone: string,
  fallback = new Date()
): string {
  const date = telegramMessageDateToDate(unixSeconds) || fallback;
  return formatLocalDateTimeAt(date, timeZone);
}
