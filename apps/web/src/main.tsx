// Entry point of the Hexlands web client. Fragment links are consumed before the first render, and again on every
// hashchange/popstate, so secrets leave the address bar as early as possible.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { watchFragmentLinks } from './fragment';
import { Store } from './store';
import './styles.css';

watchFragmentLinks(window);

const store = new Store();
const container = document.getElementById('root');
if (container === null) throw new Error('missing #root element');
createRoot(container).render(
  <StrictMode>
    <App store={store} hashers={null} />
  </StrictMode>,
);
