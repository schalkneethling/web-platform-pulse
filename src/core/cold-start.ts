/**
 * Cold start (§5.3): with no prior cursor a source seeds its index
 * silently, emitting only changes dated within this window before now —
 * enough to fill the first digest without replaying history.
 */
export const COLD_START_WINDOW_DAYS = 7;

export const withinColdStartWindow = (date: string | null, now: Date): boolean => {
  if (date === null) return false;
  const occurred = new Date(`${date}T00:00:00Z`).getTime();
  if (Number.isNaN(occurred)) return false;
  const windowStart = now.getTime() - COLD_START_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return occurred >= windowStart && occurred <= now.getTime();
};
