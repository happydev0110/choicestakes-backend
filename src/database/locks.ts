/** GET_LOCK can be returned as a string when mysql2 preserves BIGINT values. */
export function assertAdvisoryLockAcquired(value: unknown, busyMessage: string): void {
  if (value === 1 || value === '1') return;
  if (value === 0 || value === '0') throw new Error(busyMessage);
  // NULL means MySQL could not obtain a result, not that another session owns the lock.
  throw new Error('MySQL could not acquire the advisory lock. Check the database connection and server logs.');
}
