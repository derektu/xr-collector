import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PRODUCT_SOURCES } from './plugins.js';
import { SourceDeclarationsProvider } from './source-declarations.js';
import App from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <SourceDeclarationsProvider value={PRODUCT_SOURCES}>
      <App />
    </SourceDeclarationsProvider>
  </StrictMode>,
);
