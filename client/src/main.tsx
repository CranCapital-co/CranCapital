import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/fraunces/600.css';
import './styles/global.css';
import './styles/app.css';
import './styles/touch.css';
import './styles/renown.css';
import App from './App';
import { installErrorReporting } from './lib/errors';
import { installSound } from './audio/sound';

installErrorReporting();
installSound();

// Keep the game's files on the device after the first visit (see
// public/sw.js). Bump DATA_VERSION when street tiles or city data change.
const DATA_VERSION = '2026-11-25';
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const url = new URL('sw.js', document.baseURI);
    url.searchParams.set('v', __BUILD_ID__);
    url.searchParams.set('d', DATA_VERSION);
    navigator.serviceWorker.register(url.href, { scope: './' }).catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
