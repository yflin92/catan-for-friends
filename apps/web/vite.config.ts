import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';

// Content-Security-Policy for built pages (design §8). The app ships no inline scripts or styles, so 'self' suffices;
// connect-src 'self' covers same-origin ws:/wss: in current browsers. Dev mode needs inline preambles and is exempt.
export const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'";

function cspMeta(): Plugin {
  return {
    name: 'hexlands-csp-meta',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  };
}

/** Same-origin proxy of /ws and /api to a Hexlands server, so the page only ever talks to its own origin. */
export function serverProxy(target: string): Record<string, ProxyOptions> {
  return {
    '/ws': { target, ws: true },
    '/api': { target },
  };
}

const BUILD_VERSION = process.env['HEXLANDS_BUILD_VERSION'] ?? 'dev';

/** Emits dist/version.txt holding the build version baked into the bundle (design D12). */
function versionFile(): Plugin {
  return {
    name: 'hexlands-version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.txt', source: `${BUILD_VERSION}\n` });
    },
  };
}

const devTarget = process.env['HEXLANDS_SERVER_URL'] ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react(), cspMeta(), versionFile()],
  // Compared with the server's room.buildVersion (stale-bundle banner); both default to 'dev'.
  define: { __HEXLANDS_BUILD_VERSION__: JSON.stringify(BUILD_VERSION) },
  build: {
    target: 'es2022',
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  server: { proxy: serverProxy(devTarget) },
  preview: { proxy: serverProxy(devTarget) },
});
