// Home screen: start a new game, or join one by code (shown as ABC-DEF).
import { useState, type FormEvent } from 'react';
import { normalizeRoomCode } from '../fragment';
import { reasonText } from '../reasons';
import type { LobbyActions } from './lobby-actions';

export interface HomeProps {
  readonly actions: LobbyActions;
  /** Called with the canonical code and the name to join with once the room is open. */
  onJoin(roomCode: string, displayName: string): void;
}

export function Home({ actions, onJoin }: HomeProps) {
  const [hostName, setHostName] = useState('');
  const [passphrase, setPassphrase] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');
  const [joinName, setJoinName] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    const res = await actions.createRoom(hostName.trim(), passphrase ?? undefined);
    setCreating(false);
    if (!res.ok) {
      if (res.reasonCode === 'bad_passphrase' && passphrase === null) setPassphrase('');
      setCreateError(reasonText(res.reasonCode));
    }
  };

  const join = (e: FormEvent) => {
    e.preventDefault();
    const canonical = normalizeRoomCode(code);
    if (canonical === null) {
      setJoinError('That doesn’t look like a room code. It has 6 letters and digits, like ABC-DEF.');
      return;
    }
    setJoinError(null);
    onJoin(canonical, joinName.trim());
  };

  return (
    <main className="home">
      <section className="card" aria-labelledby="new-game">
        <h2 id="new-game">New game</h2>
        <form onSubmit={create}>
          <label>
            Your name
            <input name="hostName" value={hostName} maxLength={20} required autoComplete="nickname" onChange={(e) => setHostName(e.target.value)} />
          </label>
          {passphrase !== null && (
            <label>
              Passphrase
              <input name="passphrase" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </label>
          )}
          <button type="submit" disabled={creating || hostName.trim() === ''}>
            Create game
          </button>
          {createError !== null && (
            <p className="error" role="alert">
              {createError}
            </p>
          )}
        </form>
      </section>
      <section className="card" aria-labelledby="join-game">
        <h2 id="join-game">Join a game</h2>
        <form onSubmit={join}>
          <label>
            Room code
            <input name="roomCode" value={code} placeholder="ABC-DEF" autoCapitalize="characters" autoComplete="off" spellCheck={false} onChange={(e) => setCode(e.target.value)} />
          </label>
          <label>
            Your name
            <input name="joinName" value={joinName} maxLength={20} autoComplete="nickname" onChange={(e) => setJoinName(e.target.value)} />
          </label>
          <button type="submit" disabled={code.trim() === ''}>
            Join
          </button>
          {joinError !== null && (
            <p className="error" role="alert">
              {joinError}
            </p>
          )}
        </form>
      </section>
    </main>
  );
}
