import React, { createContext, useCallback, useContext, useState } from 'react';
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react';
import { cn } from '../lib/utils';

type ToastVariant = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  variant: ToastVariant;
  message: string;
}

export interface ToastAPI {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastAPI | null>(null);

let _nextId = 1;
const DISMISS_MS = 4000;

const ToastBubble: React.FC<{ toast: ToastItem; onDismiss: (id: number) => void }> = ({ toast, onDismiss }) => {
  let wrapClass: string;
  let icon: React.ReactNode;

  if (toast.variant === 'success') {
    wrapClass = 'bg-emerald-50 border-emerald-200 text-emerald-800';
    icon = <CheckCircle size={15} className="text-emerald-600 shrink-0 mt-0.5" />;
  } else if (toast.variant === 'error') {
    wrapClass = 'bg-red-50 border-red-200 text-red-800';
    icon = <AlertCircle size={15} className="text-red-600 shrink-0 mt-0.5" />;
  } else {
    wrapClass = 'bg-blue-50 border-blue-200 text-blue-800';
    icon = <Info size={15} className="text-blue-600 shrink-0 mt-0.5" />;
  }

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex items-start gap-2.5 px-3.5 py-3 rounded-2xl border shadow-lg text-sm',
        'toast-slide-in',
        wrapClass,
      )}
    >
      {icon}
      <span className="flex-1 leading-snug">{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        className="shrink-0 opacity-40 hover:opacity-80 transition-opacity mt-0.5"
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const add = useCallback((variant: ToastVariant, message: string) => {
    const id = _nextId++;
    setToasts(prev => [...prev, { id, variant, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), DISMISS_MS);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const api: ToastAPI = {
    success: (msg) => add('success', msg),
    error:   (msg) => add('error', msg),
    info:    (msg) => add('info', msg),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="fixed top-4 right-4 z-[300] flex flex-col gap-2 pointer-events-none w-80"
      >
        {toasts.map(t => (
          <ToastBubble key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastAPI {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be inside <ToastProvider>');
  return ctx;
}
