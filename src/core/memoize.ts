/**
 * Runs `load` once and hands every caller the same promise, including a
 * rejection, so two adapters that need the same download share one request
 * and see the same outcome.
 */
export const memoizeAsync = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () => (pending ??= load());
};
