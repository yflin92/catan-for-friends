// Live smoke against a deployed server (Caddy, TLS, WSS) in a real browser; skipped unless HEXLANDS_E2E_BASE_URL is set
// (see e2e/live.ts for every setting). No test hooks: the server is the production build.
// 1. A host named "smoke-test" creates a room through the UI, with the Q9 passphrase from the environment when the
//    server asks for one (its first reply is a 403, the one console error allowed); two more players join through the
//    invite link, and the third then moves to a fresh context through its rejoin link (its old tab closed). Each
//    player is its own pooled context.
// 2. The host starts; the three seats play the setup placements by picking legal targets on the board.
// 3. The first seat to roll reloads its tab: the same view (data-view-hash, data-seq) is back within 5 s, and the seat
//    still acts (it rolls).
// 4. No console errors beyond KI-1 on any page. Every page then closes: with every seat gone, the server's lifecycle
//    policy abandons the room (allDisconnectedAbandonMin) and later expires it, like any other game.
// Links open inside the page (openLink) and the passphrase never goes through a Playwright input call
// (submitWithPassphrase), so no step title holds a room code, seat token or the passphrase; live-smoke-checks.spec.ts
// checks this.
// It refuses to run inside a configured game-night window unless HEXLANDS_E2E_LIVE_OVERRIDE_WINDOW=yes.
import type { Locator, Page } from '@playwright/test';
import { expect, isEngineConsoleError, test } from './harness';
import { guardGameNightWindow, liveBaseURL, withoutSecrets } from './live';

const BASE_URL = liveBaseURL();
const PASSPHRASE = process.env['HEXLANDS_ROOMS_CREATE_PASSPHRASE'];
const NAMES = ['smoke-test', 'smoke-test-2', 'smoke-test-3'] as const;
const RESUME_LIMIT_MS = 5_000;

interface Player {
  readonly page: Page;
  readonly errors: string[];
}

/**
 * Types the passphrase, submits the create form and empties the field again, inside the page. Playwright's own input
 * calls (fill, type, insertText) put the text in their step titles, which the HTML report keeps, and a failure's
 * error context records the field's value; this way neither ever holds it. The form's submit handler reads the
 * passphrase when it is called, so the field can be emptied straight after.
 */
async function submitWithPassphrase(field: Locator, passphrase: string): Promise<void> {
  await field.evaluate(async (input: HTMLInputElement, value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const enter = (v: string) => {
      setValue.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    enter(value);
    await new Promise((resolve) => setTimeout(resolve, 0)); // the controlled input re-renders with the value
    input.form!.requestSubmit();
    enter('');
  }, passphrase);
}

/**
 * Opens an invite or rejoin link from a blank page by assigning location inside it. A Playwright navigation would
 * put the URL, and the room code or seat token in its fragment, in a step title. The app removes the fragment once
 * read (ADR-0006), which this checks.
 */
async function openLink(page: Page, link: string): Promise<void> {
  await page.evaluate((url) => setTimeout(() => location.assign(url), 0), link);
  await expect(page.locator('#app')).toBeAttached({ timeout: 15_000 });
  await expect.poll(() => new URL(page.url()).hash, { timeout: 15_000 }).toBe('');
}

test.describe('live smoke against a deployed server', () => {
  test.skip(BASE_URL === null, 'Set HEXLANDS_E2E_BASE_URL to run the live smoke against a deployed server.');
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(() => {
    const overridden = guardGameNightWindow(process.env, new Date());
    if (overridden !== null) console.warn(`live smoke running inside the game-night window ${overridden.start} – ${overridden.end} (override set)`);
  });

  test('create with the passphrase, seat 3, setup placements, a reload resumes within 5 s, clean console', async ({ pages, browserName }) => {
    const secrets = new Set<string>(PASSPHRASE ? [PASSPHRASE] : []);
    await withoutSecrets(secrets, async () => {
      const base = BASE_URL!;
      const join = async (): Promise<Player> => {
        const page = await pages.page(base);
        const errors: string[] = [];
        page.on('console', (m) => {
          if (m.type() === 'error' && !isEngineConsoleError(browserName, m.text())) errors.push(m.text());
        });
        page.on('pageerror', (e) => errors.push(String(e)));
        return { page, errors };
      };
      const players = [await join(), await join(), await join()];
      const [host, ...guests] = players.map((p) => p.page) as [Page, Page, Page];

      // 1. Create (the passphrase field appears after the server's first bad_passphrase), then join by code.
      await host.goto('/');
      await host.locator('input[name="hostName"]').fill(NAMES[0]);
      await host.getByRole('button', { name: 'Create game' }).click();
      const invite = host.locator('input[name="invite"]');
      const passphraseField = host.locator('input[name="passphrase"]');
      // A refusal other than the passphrase prompt (wrong passphrase, server full, create limit) ends the run with
      // the reason the page shows.
      const refusal = host.getByRole('alert').filter({ hasNotText: 'needs a passphrase' });
      const failIfRefused = async () => {
        if (await refusal.isVisible()) throw new Error(`the server refused to create the room: ${await refusal.innerText()}`);
      };
      await expect(invite.or(passphraseField).or(refusal)).toBeVisible({ timeout: 15_000 });
      await failIfRefused();
      if (await passphraseField.isVisible()) {
        expect(PASSPHRASE, 'the server requires a passphrase: set HEXLANDS_ROOMS_CREATE_PASSPHRASE').toBeTruthy();
        // The rejected first create is the server's 403 bad_passphrase, which some engines log as a failed resource.
        const rejected = players[0]!.errors.splice(0);
        expect(rejected.filter((e) => !/status of 403\b/.test(e)), 'console errors before the passphrase prompt').toEqual([]);
        expect(rejected.length).toBeLessThanOrEqual(1);
        await submitWithPassphrase(passphraseField, PASSPHRASE!);
        await expect(invite.or(refusal)).toBeVisible({ timeout: 15_000 });
        await failIfRefused();
      }
      const inviteLink = await invite.inputValue();
      secrets.add(inviteLink).add(inviteLink.split('#join=')[1] ?? '');
      for (const [i, g] of guests.entries()) {
        await openLink(g, inviteLink);
        await g.locator('input[name="displayName"]').fill(NAMES[i + 1]!);
        await g.getByRole('button', { name: 'Join', exact: true }).click();
        await expect(g.locator('[data-roster-seat] .tag', { hasText: 'you' })).toBeVisible({ timeout: 15_000 });
      }
      // The third seat moves to a new device: its old tab closes, its rejoin link opens in a fresh context.
      const rejoinLink = await guests[1].locator('input[name="rejoin"]').inputValue();
      secrets.add(rejoinLink).add(rejoinLink.split('.').pop() ?? '');
      expect(players[2]!.errors, 'console errors on seat 3 before it moved').toEqual([]);
      await guests[1].close();
      players[2] = await join();
      await openLink(players[2].page, rejoinLink);
      await expect(players[2].page.locator('[data-roster-seat] .tag', { hasText: 'you' })).toBeVisible({ timeout: 15_000 });
      await expect(players[2].page.locator('[data-roster-seat]', { hasText: NAMES[2] })).toBeVisible();

      // 2. Start, then the snake draft: whoever has board targets places a settlement or a road, until someone may roll.
      await host.getByRole('button', { name: 'Start game' }).click();
      for (const p of players) await expect(p.page.locator('#app')).toHaveAttribute('data-lifecycle', 'active', { timeout: 15_000 });
      const seq = async (p: Page) => Number(await p.locator('#app').getAttribute('data-seq'));
      const roller = async (): Promise<Page | null> => {
        for (const p of players) if ((await p.page.getByRole('button', { name: 'Roll dice', exact: true }).count()) > 0) return p.page;
        return null;
      };
      for (let placed = 0; (await roller()) === null; placed++) {
        expect(placed, 'the setup draft ends after 12 placements').toBeLessThan(12);
        let mover: Page | null = null;
        for (const p of players) if ((await p.page.locator('[data-target-vertex], [data-target-edge]').count()) > 0) mover = p.page;
        expect(mover, 'one seat has placement targets').not.toBeNull();
        const before = await seq(mover!);
        // A vertical edge target has a zero-width geometry box, which Playwright treats as hidden; the others are used.
        await mover!.locator('[data-target-vertex], [data-target-edge]').filter({ visible: true }).first().click();
        await mover!.getByRole('button', { name: 'Confirm', exact: true }).click();
        for (const p of players) await expect.poll(() => seq(p.page), { timeout: 15_000 }).toBeGreaterThan(before);
      }

      // 3. The seat about to roll reloads: the same view is back within 5 s, and it can still roll.
      const active = (await roller())!;
      const root = active.locator('#app');
      const viewHash = await root.getAttribute('data-view-hash');
      const atSeq = await root.getAttribute('data-seq');
      const t0 = Date.now();
      await active.reload();
      await expect(root).toHaveAttribute('data-view-hash', viewHash!, { timeout: RESUME_LIMIT_MS });
      const resumedMs = Date.now() - t0;
      await expect(root).toHaveAttribute('data-seq', atSeq!);
      console.log(`[live-smoke] ${browserName}: reload resumed in ${resumedMs} ms`);
      expect(resumedMs).toBeLessThanOrEqual(RESUME_LIMIT_MS);
      await active.getByRole('button', { name: 'Roll dice', exact: true }).click();
      for (const p of players) await expect.poll(() => seq(p.page), { timeout: 15_000 }).toBeGreaterThan(Number(atSeq));

      // 4. Clean console, then everyone leaves.
      for (const [i, p] of players.entries()) expect(p.errors, `console errors on seat ${i + 1}`).toEqual([]);
      for (const p of players) await p.page.close();
    });
  });
});
