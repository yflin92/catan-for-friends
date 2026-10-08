import { useMemo } from 'react';
import { Board } from './board/Board';
import { ConnectionNotices } from './connection-notices';
import { useStoreSnapshot, type Store } from './store';
import { rootAttributes } from './th15';

export interface AppProps {
  readonly store: Store;
  onUseHere?(): void;
  onReload?(): void;
}

/** App root. Carries the TH15 attributes, computed in the same render as the view they describe. */
export function App({ store, onUseHere = () => undefined, onReload = () => undefined }: AppProps) {
  const snapshot = useStoreSnapshot(store);
  const attrs = useMemo(() => rootAttributes(snapshot), [snapshot]);
  return (
    <div id="app" {...attrs}>
      <header className="app-header">
        <h1>Hexlands</h1>
      </header>
      <ConnectionNotices snapshot={snapshot} onUseHere={onUseHere} onReload={onReload} />
      {snapshot.view !== null && (
        <main className="app-main">
          <Board view={snapshot.view} pick={null} />
        </main>
      )}
    </div>
  );
}
