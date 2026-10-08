// Invite and rejoin links. Secrets are carried only in the URL fragment (ADR-0006, P8).

/** Room codes are shown in groups of three: "ABCDEF" → "ABC-DEF". */
export function formatRoomCode(code: string): string {
  return code.replace(/(.{3})(?=.)/g, '$1-');
}

export function inviteLink(origin: string, roomCode: string): string {
  return `${origin}/#join=${roomCode}`;
}

export function rejoinLink(origin: string, roomCode: string, seatToken: string): string {
  return `${origin}/#seat=${roomCode}.${seatToken}`;
}
