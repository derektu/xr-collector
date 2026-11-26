import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PRODUCT_SOURCES } from './plugins.js';
import { SourceDeclarationsProvider } from './sources/source-declarations.js';
import App from './App.js';
import { installInputModality } from './infra/input-modality.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

installInputModality();

createRoot(root).render(
  <StrictMode>
    <SourceDeclarationsProvider value={PRODUCT_SOURCES}>
      <App />
    </SourceDeclarationsProvider>
  </StrictMode>,
);
