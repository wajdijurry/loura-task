/**
 * Exponential backoff with bounded jitter.
 * Formula: base * 2^(attempt-1) + jitter, capped at maxDelayMs.
 * attempt is 1-based (first retry after attempt 1 fails).
 */
export function computeBackoffMs(
  attempt: number,
  random: () => number = Math.random,
  options: { baseMs?: number; maxDelayMs?: number; jitterMs?: number } = {},
): number {
  const baseMs = options.baseMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const jitterMs = options.jitterMs ?? 500;
  const exp = Math.min(maxDelayMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(random() * (jitterMs + 1));
  return Math.min(maxDelayMs, exp + jitter);
}
