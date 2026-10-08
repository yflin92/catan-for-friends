// Fault injection points on the persistence and drain paths (design §3.12, ADR-0005, TH9). Production uses NoFaults;
// startServer installs a caller-supplied implementation only when test hooks are enabled (see test-hooks.ts).

export type FaultPoint = 'beforePersist' | 'afterPersistBeforeAck' | 'beforeSnapshot' | 'duringDrain';

export const FAULT_POINTS: readonly FaultPoint[] = ['beforePersist', 'afterPersistBeforeAck', 'beforeSnapshot', 'duringDrain'];

/** 'crash' sends SIGKILL to the current process, so it is only meaningful for a server running in a child process. */
export type FaultAction = 'throw' | 'crash' | { readonly delayMs: number };

export interface FaultContext {
  readonly gameId: string;
  readonly seq: number;
}

/** hit() is synchronous because the commit path never awaits between reduce and commit. */
export interface FaultPoints {
  hit(p: FaultPoint, ctx: FaultContext): void;
}

export const NoFaults: FaultPoints = Object.freeze({ hit: () => undefined });

/** Thrown by the 'throw' action. */
export class InjectedFault extends Error {
  readonly point: FaultPoint;

  constructor(point: FaultPoint) {
    super(`injected fault at ${point}`);
    this.point = point;
    this.name = 'InjectedFault';
  }
}

/** Performs a fault action. '{delayMs}' blocks the event loop synchronously, simulating a slow fsync. */
export function performFault(point: FaultPoint, action: FaultAction): void {
  if (action === 'throw') throw new InjectedFault(point);
  if (action === 'crash') {
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  if (action.delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, action.delayMs);
}
