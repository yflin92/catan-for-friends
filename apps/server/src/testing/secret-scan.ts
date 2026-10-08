// AC30 exact-value secrets scan (design §3.12 TH12, §2.4, §9.5; Evolve G4). Every room code and seat token recorded by
// the SecretRegistry, plus the invite (#join=CODE) and rejoin (#seat=CODE.TOKEN) fragments built from them, is searched
// for in every captured artifact. An artifact may allow specific values: the POST /api/rooms response carries its own
// code and token, and a seatToken frame carries its own token to the socket that joined. Test-only.
import type { SecretKind } from '../secrets';

export type Channel = 'log' | 'stdout' | 'span' | 'metric' | 'http' | 'frame';

export interface Artifact {
  readonly channel: Channel;
  /** Where it came from, for the report (e.g. "frame → seat 2 socket 5", "POST /api/rooms 201"). */
  readonly where: string;
  readonly text: string;
  /** Exact secret values this artifact may legitimately carry. */
  readonly allowed?: readonly string[];
}

export interface Needle {
  readonly label: string;
  readonly value: string;
  /** The underlying secrets; a needle is allowed when every one of them is allowed in the artifact. */
  readonly secrets: readonly string[];
}

export interface Leak {
  readonly channel: Channel;
  readonly where: string;
  readonly needle: string;
}

/** The needles: each secret, each invite fragment and each rejoin fragment (every code with every token). */
export function needlesFor(secrets: readonly { readonly kind: SecretKind; readonly value: string }[]): Needle[] {
  const codes = secrets.filter((s) => s.kind === 'roomCode').map((s) => s.value);
  const tokens = secrets.filter((s) => s.kind === 'seatToken').map((s) => s.value);
  return [
    ...codes.map((c, i) => ({ label: `roomCode#${i}`, value: c, secrets: [c] })),
    ...tokens.map((t, i) => ({ label: `seatToken#${i}`, value: t, secrets: [t] })),
    ...codes.map((c, i) => ({ label: `invite#${i}`, value: `#join=${c}`, secrets: [c] })),
    ...codes.flatMap((c, i) => tokens.map((t, j) => ({ label: `rejoin#${i}.${j}`, value: `#seat=${c}.${t}`, secrets: [c, t] }))),
  ];
}

/** Every (artifact, needle) occurrence that the artifact does not allow. The report never contains the secret itself. */
export function findLeaks(artifacts: readonly Artifact[], needles: readonly Needle[]): Leak[] {
  const out: Leak[] = [];
  for (const a of artifacts) {
    for (const n of needles) {
      if (!a.text.includes(n.value)) continue;
      if (n.secrets.every((s) => a.allowed?.includes(s))) continue;
      out.push({ channel: a.channel, where: a.where, needle: n.label });
    }
  }
  return out;
}

/** A 43-character base64url run: the seat-token shape (G4 (i)). Hex-only runs (hashes, trace ids) are other shapes. */
const TOKEN_SHAPE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
/** A JSON key naming a secret (G4 (ii)); its value must be "[Redacted]" unless the artifact allows it. */
const SECRET_KEY = /"(roomCode|seatToken|token|passphrase)"\s*:\s*"([^"]*)"/g;
/** An invite or rejoin link fragment (G4 (iii)). */
const FRAGMENT = /#(join|seat)=/g;
/** Candidate opaque tokens for the entropy check. */
const TOKENISH = /[A-Za-z0-9+/_=-]{24,}/g;
const HEX = /^[0-9a-f]+$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bits per character above which a 24+ character token is treated as a secret. */
export const ENTROPY_THRESHOLD = 4.2;

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Secret SHAPES in runtime artifacts, independent of the registry: seat-token-shaped runs, secret-named keys with a
 * non-redacted value, link fragments, and high-entropy tokens (not hex, not a UUID). A value the artifact allows is not
 * reported. The report never contains the matched value.
 */
export function findSecretShapes(artifacts: readonly Artifact[]): Leak[] {
  const out: Leak[] = [];
  const allowed = (a: Artifact, v: string) => a.allowed?.includes(v) ?? false;
  for (const a of artifacts) {
    for (const m of a.text.matchAll(TOKEN_SHAPE)) {
      if (!HEX.test(m[0]) && !allowed(a, m[0])) out.push({ channel: a.channel, where: a.where, needle: 'shape:seat-token' });
    }
    for (const m of a.text.matchAll(SECRET_KEY)) {
      if (m[2] !== '[Redacted]' && !allowed(a, m[2]!)) out.push({ channel: a.channel, where: a.where, needle: `shape:key:${m[1]}` });
    }
    for (const m of a.text.matchAll(FRAGMENT)) out.push({ channel: a.channel, where: a.where, needle: `shape:fragment:${m[1]}` });
    for (const m of a.text.matchAll(TOKENISH)) {
      const t = m[0];
      if (HEX.test(t) || UUID.test(t) || allowed(a, t) || entropy(t) < ENTROPY_THRESHOLD) continue;
      out.push({ channel: a.channel, where: a.where, needle: 'shape:high-entropy' });
    }
  }
  return out;
}
