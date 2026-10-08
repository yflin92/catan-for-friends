// The room this tab is in, kept in sessionStorage so a reload of the tab returns to the same room (AC23). Per tab, so
// two tabs can be in different rooms; never in the URL. The seat token itself stays in localStorage (fragment.ts).
const KEY = 'hexlands.activeRoom';

export function rememberRoom(storage: Pick<Storage, 'setItem'>, roomCode: string): void {
  try {
    storage.setItem(KEY, roomCode);
  } catch {
    // Storage may be unavailable (private mode); the tab then simply forgets the room on reload.
  }
}

export function recallRoom(storage: Pick<Storage, 'getItem'>): string | null {
  try {
    return storage.getItem(KEY);
  } catch {
    return null;
  }
}
