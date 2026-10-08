// Runs before any schema is used: zod's JIT probes `new Function` once, which the page's CSP (no 'unsafe-eval')
// refuses and logs as a console error. jitless parsing never evaluates code. This module must be imported first in
// main.tsx so it runs before @hexlands/protocol builds its schemas; both resolve to the same zod instance.
import { z } from 'zod';

z.config({ jitless: true });
