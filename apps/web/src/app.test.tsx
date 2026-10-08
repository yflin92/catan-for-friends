import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './app';
import { EMPTY_SNAPSHOT, Store } from './store';
import { boardViewFixture } from './testing/board-fixture';
import type { PlayerViewWire, RoomView } from './wire';

const view = { schemaVersion: 1, you: 1, ...boardViewFixture() } as unknown as PlayerViewWire;
const room = { lifecycle: 'active' } as unknown as RoomView;

describe('App root', () => {
  it('always carries the five TH15 attributes, empty before a view exists', () => {
    const html = renderToStaticMarkup(<App store={new Store()} />);
    for (const a of ['data-seq', 'data-view-hash', 'data-public-hash', 'data-lifecycle', 'data-seat']) {
      expect(html).toContain(`${a}=""`);
    }
  });

  it('renders the attributes from the same snapshot as the view', () => {
    const store = new Store();
    store.update({ roomCode: 'ABCDEF', room, view, seq: 9, viewHash: 'abc', publicHash: 'def', seat: 1 });
    const html = renderToStaticMarkup(<App store={store} />);
    expect(html).toContain('data-seq="9"');
    expect(html).toContain('data-view-hash="abc"');
    expect(html).toContain('data-public-hash="def"');
    expect(html).toContain('data-lifecycle="active"');
    expect(html).toContain('data-seat="1"');
    expect(html).toContain('aria-label="Game board"');
  });

  it('shows no board before a view exists', () => {
    expect(renderToStaticMarkup(<App store={new Store()} />)).not.toContain('Game board');
  });

  it('shows "Use here" after a supersede, and the reload banner only enables with nothing pending', () => {
    const superseded = new Store({ ...EMPTY_SNAPSHOT, connection: { status: 'stopped', terminal: 'superseded' } });
    const html = renderToStaticMarkup(<App store={superseded} />);
    expect(html).toContain('This seat was opened on another device.');
    expect(html).toContain('>Use here</button>');

    const stale = new Store({ ...EMPTY_SNAPSHOT, staleBundle: true });
    expect(renderToStaticMarkup(<App store={stale} />)).toMatch(/A new version is available — reload\.<\/p><button type="button">Reload/);
    const busy = new Store({
      ...EMPTY_SNAPSHOT,
      staleBundle: true,
      pending: new Map([['a', { actionId: 'a', msg: {}, sentAt: 0 }]]),
    });
    expect(renderToStaticMarkup(<App store={busy} />)).toContain('disabled=""');
  });
});
