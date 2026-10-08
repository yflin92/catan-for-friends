// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Action, LegalActions } from '@hexlands/engine';
import { wireViewFixture } from '../testing/view-fixture';
import type { PlayerViewWire, RoomView } from '../wire';
import { TradePanel } from './TradePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const room = {
  seats: [
    { seat: 0, name: 'Ann', connected: true },
    { seat: 1, name: 'Bo', connected: true },
    { seat: 2, name: 'Cy', connected: true },
  ],
} as unknown as RoomView;
const rc = (brick = 0, lumber = 0, wool = 0, grain = 0, ore = 0) => ({ brick, lumber, wool, grain, ore });
const NONE: Partial<LegalActions> = { proposeTrade: false, respondTrade: null, confirmTrade: null, cancelTrade: null, maritime: {} };

function viewWith(legal: Partial<LegalActions>, extra: Record<string, unknown> = {}): PlayerViewWire {
  const base = wireViewFixture([]);
  return { ...base, hand: rc(4, 1, 1, 0, 0), ...extra, legal: { ...base.legal, ...NONE, ...legal } } as PlayerViewWire;
}
const offer = (from: number, responses: string[]) => ({ id: 7, from, give: rc(1), get: rc(0, 0, 0, 1), responses });

let container: HTMLDivElement;
let root: Root;
let sent: Action[];
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  sent = [];
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (view: PlayerViewWire) => act(() => root.render(<TradePanel view={view} room={room} busy={false} onAction={(a) => sent.push(a)} />));
const btn = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text));
function setInput(name: string, value: string) {
  const el = container.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement;
  act(() => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
const click = (b: HTMLButtonElement | undefined) => act(() => b!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

describe('player offers (AC16, DR2)', () => {
  it('the active player proposes {give, get}; a second proposal is labelled as a replacement', () => {
    render(viewWith({ proposeTrade: true }));
    expect(btn('Offer to players')!.disabled).toBe(true);
    setInput('You give-brick', '2');
    setInput('You get-grain', '1');
    act(() => (container.querySelector('form.composer') as HTMLFormElement).requestSubmit());
    expect(sent).toEqual([{ type: 'proposeTrade', give: rc(2), get: rc(0, 0, 0, 1) }]);
    render(viewWith({ proposeTrade: true, cancelTrade: 7 }, { trade: offer(1, ['pending', 'self', 'pending']) }));
    expect(btn('Replace offer')).toBeDefined();
  });

  it('non-active seats never see propose controls', () => {
    render(viewWith({ proposeTrade: false }, { trade: offer(0, ['self', 'pending', 'pending']) }));
    expect(container.querySelector('form.composer')).toBeNull();
  });

  it('decline is always offered; Accept is shown only when canAccept (DR2); both carry the offer id', () => {
    render(viewWith({ respondTrade: { tradeId: 7, canAccept: false } }, { trade: offer(0, ['self', 'pending', 'pending']) }));
    expect(container.textContent).toContain('Ann offers: gives 1 brick, wants 1 grain.');
    expect(btn('Accept')).toBeUndefined();
    expect(btn('Decline')!.disabled).toBe(false);
    click(btn('Decline'));
    render(viewWith({ respondTrade: { tradeId: 7, canAccept: true } }, { trade: offer(0, ['self', 'pending', 'pending']) }));
    click(btn('Accept'));
    expect(sent).toEqual([
      { type: 'respondTrade', tradeId: 7, accept: false },
      { type: 'respondTrade', tradeId: 7, accept: true },
    ]);
  });

  it('the proposer confirms only with seats in legal.confirmTrade.partners, or cancels', () => {
    const trade = offer(1, ['accepted', 'self', 'accepted']);
    render(viewWith({ confirmTrade: { tradeId: 7, partners: [2] }, cancelTrade: 7 }, { trade }));
    expect(container.querySelector('[data-response-seat="0"]')?.textContent).toBe('Ann: accepted');
    expect(btn('Trade with Ann')).toBeUndefined();
    click(btn('Trade with Cy'));
    click(btn('Cancel offer'));
    expect(sent).toEqual([
      { type: 'confirmTrade', tradeId: 7, partner: 2 },
      { type: 'cancelTrade', tradeId: 7 },
    ]);
  });

  it.each([
    ['confirmed', 2, 'Trade completed with Cy.'],
    ['cancelled', null, 'The offer was cancelled.'],
    ['withdrawn', null, 'The offer was withdrawn when the turn moved on.'],
  ] as const)('when the offer is gone, the log explains it (%s)', (outcome, partner, text) => {
    const log = [{ n: 3, event: { kind: 'tradeResolved', tradeId: 7, outcome, partner, ...(outcome === 'withdrawn' ? { exitTo: 'preRoll' } : {}) }, visibleTo: 'all' }];
    render(viewWith({}, { trade: null, log }));
    expect(container.querySelector('[data-testid="trade-closed"]')?.textContent).toBe(text);
    expect(container.querySelector('.offer')).toBeNull();
  });
});

describe('maritime (AC17)', () => {
  it('offers the ratios from legal.maritime and sends maritimeTrade', () => {
    render(viewWith({ maritime: { brick: 2, lumber: 4 }, bankStock: rc(19, 19, 19, 19, 0) }));
    const options = [...container.querySelectorAll('[name="maritimeGive"] option')].map((o) => o.textContent);
    expect(options).toEqual(['Brick (2:1)', 'Lumber (4:1)']);
    setInput('maritimeReceive', 'grain');
    setInput('maritimeCount', '2');
    expect(btn('Trade 4 brick for 2 grain')).toBeDefined();
    act(() => (container.querySelector('form.maritime') as HTMLFormElement).requestSubmit());
    expect(sent).toEqual([{ type: 'maritimeTrade', give: 'brick', receive: 'grain', count: 2 }]);
  });

  it('follows legal.maritime when a chosen give resource is no longer offered', () => {
    render(viewWith({ maritime: { brick: 2, lumber: 4 }, bankStock: rc(19, 19, 19, 19, 19) }));
    setInput('maritimeGive', 'lumber');
    expect(btn('Trade 4 lumber')).toBeDefined();
    render(viewWith({ maritime: { brick: 2 }, bankStock: rc(19, 19, 19, 19, 19) }));
    expect((container.querySelector('[name="maritimeGive"]') as HTMLSelectElement).value).toBe('brick');
    expect(btn('Trade 2 brick')).toBeDefined();
    act(() => (container.querySelector('form.maritime') as HTMLFormElement).requestSubmit());
    expect(sent.at(-1)).toMatchObject({ type: 'maritimeTrade', give: 'brick', count: 1 });
  });

  it('is hidden when legal.maritime is empty', () => {
    render(viewWith({ maritime: {} }));
    expect(container.querySelector('form.maritime')).toBeNull();
  });
});

it('trade rejection codes have friendly text', async () => {
  const { reasonText } = await import('../reasons');
  expect(reasonText('trade_not_found')).toBe('That offer is no longer open.');
  expect(reasonText('trade_stale')).toMatch(/no longer has the cards/);
  expect(reasonText('trade_not_accepted')).toMatch(/hasn’t accepted/);
});
