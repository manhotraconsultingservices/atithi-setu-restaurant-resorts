import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { ToastProvider } from './components/Toast.tsx';
import { ConfirmDialogProvider } from './components/ConfirmDialog.tsx';
import { PaymentDialogProvider } from './components/PaymentDialog.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmDialogProvider>
        <PaymentDialogProvider>
          <App />
        </PaymentDialogProvider>
      </ConfirmDialogProvider>
    </ToastProvider>
  </StrictMode>,
);

// Register PWA service worker (production + HTTPS only)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {/* SW unavailable — no-op */});
  });
}
