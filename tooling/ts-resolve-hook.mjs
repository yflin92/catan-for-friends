// Node module hook for running engine TypeScript sources directly in a child process (with --experimental-strip-types):
// resolves extensionless relative imports to `<path>.ts`, then `<path>/index.ts`.
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (!specifier.startsWith('.') || /\\.[cm]?[jt]s$/.test(specifier)) throw error;
    try {
      return await next(specifier + '.ts', context);
    } catch {
      return next(specifier + '/index.ts', context);
    }
  }
}`),
);
