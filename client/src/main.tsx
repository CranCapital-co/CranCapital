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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
