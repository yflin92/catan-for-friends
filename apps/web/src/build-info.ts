// This bundle's build version, injected at build time (vite `define`); 'dev' when not injected. The server reports
// its own in room.buildVersion; a mismatch shows the reload banner.
declare const __HEXLANDS_BUILD_VERSION__: string | undefined;

export const BUILD_VERSION: string = typeof __HEXLANDS_BUILD_VERSION__ === 'string' ? __HEXLANDS_BUILD_VERSION__ : 'dev';
