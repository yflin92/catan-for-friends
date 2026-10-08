import { useMemo, useState } from 'react';
import { ConnectionNotices } from './connection-notices';
import { GameScreen, OFFLINE_GAME_ACTIONS, type GameActions } from './game/GameScreen';
import './game/game.css';
import { formatRoomCode } from './lobby/links';
import { Home } from './lobby/Home';
import { Lobby } from './lobby/Lobby';
import { OFFLINE_LOBBY_ACTIONS, type LobbyActions } from './lobby/lobby-actions';
import { useStoreSnapshot, type Store } from './store';
import { rootAttributes } from './th15';
import './lobby/lobby.css';

export interface AppProps {
  readonly store: Store;
  readonly lobby?: LobbyActions;
  readonly game?: GameActions;
  /** Page origin used to build invite and rejoin links. */
  readonly origin?: string;
  readonly storage?: Pick<Storage, 'getItem'>;
  onUseHere?(): void;
  onReload?(): void;
}

const NO_STORAGE: Pick<Storage, 'getItem'> = { getItem: () => null };

/**
 * App root. Carries the TH15 attributes, computed in the same render as the view they describe, and shows the home
 * screen, the lobby or the board depending on the room's lifecycle.
 */
export function App({
  store,
  lobby = OFFLINE_LOBBY_ACTIONS,
  game = OFFLINE_GAME_ACTIONS,
  origin = '',
  storage = NO_STORAGE,
  onUseHere = () => undefined,
  onReload = () => undefined,
}: AppProps) {
  const snapshot = useStoreSnapshot(store);
  const attrs = useMemo(() => rootAttributes(snapshot), [snapshot]);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const { roomCode, room, view } = snapshot;

  let screen;
  if (roomCode === null) {
    screen = (
      <Home
        actions={lobby}
        onJoin={(code, name) => {
          setPendingName(name === '' ? null : name);
          lobby.enterRoom(code);
        }}
      />
    );
  } else if (room === null) {
    screen = <p className="app-status">Connecting to room {formatRoomCode(roomCode)}…</p>;
  } else if (room.lifecycle === 'lobby') {
    screen = (
      <Lobby
        snapshot={{ ...snapshot, roomCode, room }}
        actions={lobby}
        origin={origin}
        storage={storage}
        pendingName={pendingName}
        onPendingNameUsed={() => setPendingName(null)}
      />
    );
  } else if (view !== null) {
    screen = <GameScreen snapshot={snapshot} view={view} actions={game} />;
  } else {
    screen = <p className="app-status">This game has already started.</p>;
  }

  return (
    <div id="app" {...attrs}>
      <header className="app-header">
        <h1>Hexlands</h1>
      </header>
      <ConnectionNotices snapshot={snapshot} onUseHere={onUseHere} onReload={onReload} />
      {screen}
    </div>
  );
}
