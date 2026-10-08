// Bundles the production entry (src/main.ts) and the workspace packages it imports into dist/main.mjs for the container
// image. better-sqlite3 (a native addon) stays external and is installed into the image's node_modules. Test files are
// never reachable from the entry, so the bundle contains none.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['better-sqlite3'],
  // CommonJS dependencies inside an ESM bundle still call require().
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  sourcemap: false,
  logLevel: 'warning',
});
