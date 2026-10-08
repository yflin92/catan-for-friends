// Recursively freezes a value so tests can prove the engine never mutates its inputs.
export function freezeDeep<T>(x: T): T {
  if (typeof x === 'object' && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) freezeDeep(v);
  }
  return x;
}
