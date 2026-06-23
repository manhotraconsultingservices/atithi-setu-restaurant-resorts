import React, { createContext, useCallback, useContext, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '../lib/utils';

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmDialogContext = createContext<ConfirmFn | null>(null);

interface Pending {
  opts: ConfirmOptions;
  resolve: (value: boolean) => void;
}

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm: ConfirmFn = useCallback(
    (opts) => new Promise<boolean>((resolve) => setPending({ opts, resolve })),
    [],
  );

  const settle = (value: boolean) => {
    pending?.resolve(value);
    setPending(null);
  };

  return (
    <ConfirmDialogContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[280] flex items-center justify-center p-4"
        >
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6">
            {pending.opts.danger && (
              <div className="flex justify-center mb-4">
                <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-100">
                  <AlertTriangle size={22} className="text-red-600" />
                </span>
              </div>
            )}
            <h3
              id="confirm-title"
              className="text-center font-semibold text-[#3d3128] text-base leading-snug mb-2"
            >
              {pending.opts.title}
            </h3>
            {pending.opts.body && (
              <p className="text-center text-sm text-gray-500 mb-1">{pending.opts.body}</p>
            )}
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => settle(false)}
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                {pending.opts.cancelLabel ?? 'Cancel'}
              </button>
              <button
                autoFocus={!pending.opts.danger}
                onClick={() => settle(true)}
                className={cn(
                  'flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-white transition-colors',
                  pending.opts.danger
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-[#cc5a16] hover:bg-[#b34d12]',
                )}
              >
                {pending.opts.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmDialogContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmDialogContext);
  if (!ctx) throw new Error('useConfirm must be inside <ConfirmDialogProvider>');
  return ctx;
}
