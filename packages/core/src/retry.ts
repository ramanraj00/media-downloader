/**
 * Calculates a delay using exponential backoff with jitter.
 * 
 * @param attempt The current attempt number (0-indexed)
 * @param baseDelayMs The base delay in milliseconds
 * @param maxDelayMs The maximum delay in milliseconds
 * @returns The calculated delay in milliseconds
 */
export function calculateBackoffDelay(attempt: number, baseDelayMs: number = 2000, maxDelayMs: number = 60000): number {
  // Exponential backoff
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  
  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  
  // Add jitter (randomized +/- 20%)
  const jitter = cappedDelay * 0.2;
  const randomizedDelay = cappedDelay - jitter + Math.random() * (jitter * 2);
  
  return Math.floor(randomizedDelay);
}
