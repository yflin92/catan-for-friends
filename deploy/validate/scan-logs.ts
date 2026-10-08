// Local rehearsal helper (deploy/validate/rehearse.sh, check #9): scans container log files (current and rotated) for
// secrets, two ways: the exact room codes and seat tokens the rehearsal created (from rehearse-games.ts --secrets), and
// the production secret-shape LogQL regex of alert A1 (G4). Prints counts per file only, never a match; exits 1 on any hit.
//
//   node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs deploy/validate/scan-logs.ts \
//     --secrets secrets.json <log file>...
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { SECRET_LINE_REGEX } from '../observability/rules';

const { values, positionals } = parseArgs({ options: { secrets: { type: 'string' } }, allowPositionals: true });
if (!values.secrets || positionals.length === 0) {
  console.error('usage: scan-logs.ts --secrets <file> <log file>...');
  process.exit(2);
}
const secrets = JSON.parse(readFileSync(values.secrets, 'utf8')) as { roomCodes: string[]; seatTokens: string[] };
const exact = [...secrets.roomCodes, ...secrets.seatTokens].filter((s) => s.length >= 6);
// The LogQL regex is RE2; it is also a valid JavaScript regex. It runs on the log body (the JSON event), which the
// json-file driver stores JSON-escaped inside its own record, so each record is unwrapped first.
const shape = new RegExp(SECRET_LINE_REGEX);

let hits = 0;
let lines = 0;
for (const file of positionals) {
  let exactHits = 0;
  let shapeHits = 0;
  let fileLines = 0;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (raw === '') continue;
    fileLines++;
    let body = raw;
    try {
      body = String((JSON.parse(raw) as { log?: unknown }).log ?? raw);
    } catch {
      // Not a json-file record: scan the raw line.
    }
    if (exact.some((s) => raw.includes(s) || body.includes(s))) exactHits++;
    if (shape.test(body)) shapeHits++;
  }
  console.log(JSON.stringify({ file: file.split('/').pop(), lines: fileLines, exactHits, shapeHits }));
  hits += exactHits + shapeHits;
  lines += fileLines;
}
console.log(JSON.stringify({ files: positionals.length, lines, values: exact.length, hits }));
process.exit(hits === 0 ? 0 : 1);
