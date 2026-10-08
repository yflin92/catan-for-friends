// Connection notices driven by the store: the terminal messages ("Use here" after a supersede, "Retry" after a
// rejected hello) and the non-blocking stale-bundle banner (design D6). Reload is offered only while no action is
// pending.
import type { StoreSnapshot } from './store';

export interface ConnectionNoticesProps {
  readonly snapshot: StoreSnapshot;
  onUseHere(): void;
  onReload(): void;
}

export function ConnectionNotices({ snapshot, onUseHere, onReload }: ConnectionNoticesProps) {
  const { connection, staleBundle, pending } = snapshot;
  return (
    <>
      {connection.terminal === 'superseded' && (
        <div className="notice notice-blocking" role="alert" data-notice="superseded">
          <p>This seat was opened on another device.</p>
          <button type="button" onClick={onUseHere}>
            Use here
          </button>
        </div>
      )}
      {connection.terminal === 'auth_failed' && (
        <div className="notice notice-blocking" role="alert" data-notice="auth-failed">
          <p>This seat link is no longer valid.</p>
        </div>
      )}
      {(connection.terminal === 'game_gone' || snapshot.room?.lifecycle === 'expired') && (
        <div className="notice notice-blocking" role="alert" data-notice="game-gone">
          <p>This game has expired.</p>
        </div>
      )}
      {connection.terminal === 'connect_failed' && (
        <div className="notice notice-blocking" role="alert" data-notice="connect-failed">
          <p>Couldn’t connect to the room.</p>
          <button type="button" onClick={onUseHere}>
            Retry
          </button>
        </div>
      )}
      {connection.status === 'reconnecting' && (
        <div className="notice" role="status" data-notice="reconnecting">
          <p>Reconnecting…</p>
        </div>
      )}
      {staleBundle && (
        <div className="notice" role="status" data-notice="stale-bundle">
          <p>A new version is available — reload.</p>
          <button type="button" onClick={onReload} disabled={pending.size > 0}>
            Reload
          </button>
        </div>
      )}
    </>
  );
}
