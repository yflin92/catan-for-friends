// Display-name rule shared by room creation and lobby join/rename (design §5.1, §8): NFC-normalised and trimmed,
// 1–20 characters (code points), no control characters. Names are rendered as text only.

export const DISPLAY_NAME_MAX = 20;

/** The normalised name, or null when it is invalid (→ invalid_name). */
export function normalizeDisplayName(raw: string): string | null {
  const name = raw.normalize('NFC').trim();
  const length = [...name].length;
  if (length < 1 || length > DISPLAY_NAME_MAX) return null;
  if (/\p{Cc}/u.test(name)) return null;
  return name;
}
