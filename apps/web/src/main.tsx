// Entry point of the Hexlands web client. Fragment links are consumed before the first render, and again on every
// hashchange/popstate, so secrets leave the address bar as early as possible; a link starts the room session, and a
// reload returns the tab to its remembered room.
import './zod-config';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { recallRoom, rememberRoom } from './active-room';
import { App } from './app';
import { BUILD_VERSION } from './build-info';
import { readCredentials, watchFragmentLinks } from './fragment';
import { createLobbyActions } from './lobby/lobby-actions';
import { LogStore } from './log-store';
import { Store } from './store';
import { browserPageEnv, browserSocket, WsClient, wsUrl } from './ws-client';
import './styles.css';

const store = new Store();
const log = new LogStore();
const client = new WsClient({
  url: wsUrl(window.location),
  createSocket: browserSocket,
  store,
  log,
  storage: window.localStorage,
  timers: {
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (h) => window.clearInterval(h as number),
  },
  page: browserPageEnv(window),
  random: Math.random,
  uuid: () => crypto.randomUUID(),
  buildVersion: BUILD_VERSION,
});

window.addEventListener('error', (e) => client.reportError('js_error', e.message));
/** Enters a room and remembers it for this tab, so a reload reconnects to it at once. */
const startRoom = (roomCode: string) => {
  rememberRoom(window.sessionStorage, roomCode);
  client.start(roomCode);
};
const lobby = createLobbyActions({
  client: { start: startRoom, sendLobby: (op) => client.sendLobby(op) },
  storage: window.localStorage,
  fetchFn: (input, init) => fetch(input, init),
});
let linked = false;
watchFragmentLinks(window, (creds) => {
  linked = true;
  startRoom(creds.roomCode);
});
// After a reload there is no link: rejoin this tab's room with the stored credentials (first attempt immediate).
const remembered = recallRoom(window.sessionStorage);
if (!linked && remembered !== null && readCredentials(window.localStorage, remembered) !== null) startRoom(remembered);

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root element');
createRoot(container).render(
  <StrictMode>
    <App
      store={store}
      lobby={lobby}
      game={{ act: (action) => client.sendAction(action), control: (op) => client.sendControl(op) }}
      log={log}
      origin={window.location.origin}
      storage={window.localStorage}
      onUseHere={() => client.useHere()}
      onReload={() => window.location.reload()}
    />
  </StrictMode>,
);
