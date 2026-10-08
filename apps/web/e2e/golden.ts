// V15 golden games for UI end-to-end runs: load a golden, build a seq-0 state from a prefix of its commands (via
// testHooks.initialState), and perform a golden command through the controls of the acting seat's page.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { reduce, stateHash, type Command, type GameState } from '@hexlands/engine';

export interface GoldenStep {
  readonly command: Command;
  readonly stateHash: string;
}

export interface Golden {
  readonly init: { readonly seed: string; readonly playerCount: 3 | 4 };
  readonly initialStateHash: string;
  readonly steps: readonly GoldenStep[];
}

export const golden = (players: 3 | 4): Golden =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../packages/engine/src/__fixtures__/golden/v15-game-${players}p.json`, import.meta.url)), 'utf8'),
  ) as Golden;

/** The golden's own commands replayed from the created state, checking each step's hash: reachable by construction. */
export function goldenPrefix(g: Golden, steps: readonly GoldenStep[]): (created: GameState) => GameState {
  return (created) => {
    if (stateHash(created) !== g.initialStateHash) throw new Error('the created state differs from the golden init');
    return steps.reduce((s, step, i) => {
      const r = reduce(s, step.command);
      if (!r.ok || stateHash(r.state) !== step.stateHash) throw new Error(`golden step ${i} does not replay`);
      return r.state;
    }, created);
  };
}

/**
 * Performs `cmd` through the controls of its seat's page (pages[seat]); covers the command types the golden tails
 * contain. Pages in `touch` are tapped rather than clicked. `names` are the seat names, for "Trade with <name>".
 */
export async function perform(pages: readonly Page[], { by, action }: Command, names: readonly string[], touch: ReadonlySet<Page> = new Set()): Promise<void> {
  const page = pages[by as number]!;
  const press = (sel: ReturnType<Page['locator']>) => (touch.has(page) ? sel.tap() : sel.click());
  const button = (name: string) => press(page.getByRole('button', { name, exact: true }));
  const place = async (build: string, target: string) => {
    await press(page.locator('.builds button', { hasText: build }));
    await press(page.locator(target));
    await button('Confirm');
  };
  switch (action.type) {
    case 'rollDice':
      return button('Roll dice');
    case 'endTurn':
      return button('End turn');
    case 'proposeTrade':
      for (const [side, counts] of [['You give', action.give], ['You get', action.get]] as const) {
        for (const [r, n] of Object.entries(counts)) if (n > 0) await page.locator(`input[name="${side}-${r}"]`).fill(String(n));
      }
      return button('Offer to players');
    case 'respondTrade':
      return button(action.accept ? 'Accept' : 'Decline');
    case 'confirmTrade':
      return button(`Trade with ${names[action.partner as number]}`);
    case 'placeSettlement':
      return place('Settlement', `[data-target-vertex="${action.vertex}"]`);
    case 'buildCity':
      return place('City', `[data-target-vertex="${action.vertex}"]`);
    case 'placeRoad':
      return place('Road', `[data-target-edge="${action.edge}"]`);
    default:
      throw new Error(`no UI driver for ${action.type}`);
  }
}
