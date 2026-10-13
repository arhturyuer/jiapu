export function createReportCache<T extends { asOf: string }, F extends { startDay: string; endDay: string; window: string; paymentMode: string }>(
  loader: (filters: F) => Promise<T>, now?: () => number
): (filters: F) => Promise<T>;
