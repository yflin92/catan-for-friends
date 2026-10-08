// Room codes and seat tokens (design §4, ADR-0006; P7). Both come from the server CSPRNG; tokens are stored only as
// their SHA-256 hash.
import { createHash, randomBytes, randomInt } from 'node:crypto';

/** 32 symbols (drops 0/O/1/I): 6 symbols carry exactly 30 bits. */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const SEAT_TOKEN_BYTES = 32;

export function mintRoomCode(length: number): string {
  let code = '';
  for (let i = 0; i < length; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}

/** 256 CSPRNG bits, base64url (43 characters). */
export function mintSeatToken(): string {
  return randomBytes(SEAT_TOKEN_BYTES).toString('base64url');
}

export function hashSeatToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
