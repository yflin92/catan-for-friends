import { useMemo } from 'react';
import { Board } from './board/Board';
import { useStoreSnapshot, type Store } from './store';
import { rootAttributes, type ViewHashers } from './th15';

export interface AppProps {
  readonly store: Store;
  readonly hashers: ViewHashers | null;
}

/** App root. Carries the TH15 attributes, computed in the same render as the view they describe. */
export function App({ store, hashers }: AppProps) {
  const snapshot = useStoreSnapshot(store);
  const attrs = useMemo(() => rootAttributes(snapshot, hashers), [snapshot, hashers]);
  return (
    <div id="app" {...attrs}>
      <header className="app-header">
        <h1>Hexlands</h1>
      </header>
      {snapshot.view !== null && (
        <main className="app-main">
          <Board view={snapshot.view} pick={null} />
        </main>
      )}
    </div>
  );
}
