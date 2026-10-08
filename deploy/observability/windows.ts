// Game-night windows (ops.gameNightWindows, requirements §13) → a Grafana time interval and dashboard annotations.
// The time interval gates the NFR9 window alert's notifications inside Grafana, so it is evaluated by Grafana even
// while the game server is down (X-alerts item 2).

/** One configured window: ISO instants with an offset, end after start. */
export interface GameNightWindow {
  readonly start: string;
  readonly end: string;
}

/** A Grafana time interval entry (alerting provisioning API, mute-timings). All values are UTC. */
export interface GrafanaTimeRange {
  readonly times: readonly { readonly start_time: string; readonly end_time: string }[];
  readonly days_of_month: readonly string[];
  readonly months: readonly string[];
  readonly years: readonly string[];
  readonly location: 'UTC';
}

const DAY_MS = 24 * 60 * 60_000;
const pad = (n: number): string => String(n).padStart(2, '0');
const hhmm = (d: Date): string => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

/** Parses HEXLANDS_OPS_GAME_NIGHT_WINDOWS (a JSON array of {start, end}); empty or unset means no windows. */
export function parseWindows(raw: string | undefined): readonly GameNightWindow[] {
  if (raw === undefined || raw.trim() === '') return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('gameNightWindows must be a JSON array');
  return value.map((w: unknown, i) => {
    const start = (w as { start?: unknown }).start;
    const end = (w as { end?: unknown }).end;
    if (typeof start !== 'string' || typeof end !== 'string') throw new Error(`gameNightWindows[${i}] needs start and end`);
    const s = Date.parse(start);
    const e = Date.parse(end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw new Error(`gameNightWindows[${i}] is not a valid range`);
    return { start, end };
  });
}

/**
 * The time ranges of a Grafana time interval covering every window. A window is split at each UTC midnight into one
 * entry per calendar day (year + month + day of month + clock times); a piece ending at midnight ends at "24:00".
 */
export function toTimeRanges(windows: readonly GameNightWindow[]): readonly GrafanaTimeRange[] {
  const out: GrafanaTimeRange[] = [];
  for (const w of windows) {
    let from = Date.parse(w.start);
    const to = Date.parse(w.end);
    while (from < to) {
      const day = new Date(from);
      const nextMidnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + DAY_MS;
      const pieceEnd = Math.min(to, nextMidnight);
      out.push({
        times: [{ start_time: hhmm(day), end_time: pieceEnd === nextMidnight ? '24:00' : hhmm(new Date(pieceEnd)) }],
        days_of_month: [String(day.getUTCDate())],
        months: [String(day.getUTCMonth() + 1)],
        years: [String(day.getUTCFullYear())],
        location: 'UTC',
      });
      from = pieceEnd;
    }
  }
  return out;
}

/** Region annotations (epoch ms) marking each window on the dashboard. */
export function toAnnotations(windows: readonly GameNightWindow[]): readonly { time: number; timeEnd: number; text: string }[] {
  return windows.map((w) => ({ time: Date.parse(w.start), timeEnd: Date.parse(w.end), text: 'game night' }));
}
