import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './app';
import { Store } from './store';
import { boardViewFixture } from './testing/board-fixture';
import type { PlayerViewWire, RoomView } from './wire';

const view = { schemaVersion: 1, you: 1, ...boardViewFixture() } as unknown as PlayerViewWire;
const room = { lifecycle: 'lobby' } as unknown as RoomView;

describe('App root', () => {
  it('always carries the five TH15 attributes, empty before a view exists', () => {
    const html = renderToStaticMarkup(<App store={new Store()} hashers={null} />);
    for (const a of ['data-seq', 'data-view-hash', 'data-public-hash', 'data-lifecycle', 'data-seat']) {
      expect(html).toContain(`${a}=""`);
    }
  });

  it('renders the attributes from the same snapshot as the view', () => {
    const store = new Store();
    store.update({ room, view, seq: 9, seat: 1 });
    const html = renderToStaticMarkup(
      <App store={store} hashers={{ viewHash: () => 'abc', publicProjectionHash: () => 'def' }} />,
    );
    expect(html).toContain('data-seq="9"');
    expect(html).toContain('data-view-hash="abc"');
    expect(html).toContain('data-public-hash="def"');
    expect(html).toContain('data-lifecycle="lobby"');
    expect(html).toContain('data-seat="1"');
    expect(html).toContain('aria-label="Game board"');
  });

  it('shows no board before a view exists', () => {
    expect(renderToStaticMarkup(<App store={new Store()} hashers={null} />)).not.toContain('Game board');
  });
});
