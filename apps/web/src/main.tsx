// Entry point of the Hexlands web client. Fragment links are consumed before the first render, and again on every
// hashchange/popstate, so secrets leave the address bar as early as possible; a link starts the room session.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { BUILD_VERSION } from './build-info';
import { watchFragmentLinks } from './fragment';
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
watchFragmentLinks(window, (creds) => client.start(creds.roomCode));

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root element');
createRoot(container).render(
  <StrictMode>
    <App store={store} onUseHere={() => client.useHere()} onReload={() => window.location.reload()} />
  </StrictMode>,
);
