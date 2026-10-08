// Entry point of the Hexlands web client. Fragment links are consumed before the first render so secrets leave the
// address bar as early as possible.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { consumeFragment } from './fragment';
import { Store } from './store';
import './styles.css';

consumeFragment({ location: window.location, history: window.history, storage: window.localStorage });

const store = new Store();
const container = document.getElementById('root');
if (container === null) throw new Error('missing #root element');
createRoot(container).render(
  <StrictMode>
    <App store={store} hashers={null} />
  </StrictMode>,
);
