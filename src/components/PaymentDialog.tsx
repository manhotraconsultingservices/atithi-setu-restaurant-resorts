import React, { createContext, useCallback, useContext, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';

export interface PaymentField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'textarea' | 'password';
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
}

export interface PaymentDialogOptions {
  title: string;
  body?: string;
  fields: PaymentField[];
  confirmLabel?: string;
}

export type PaymentDialogFn = (opts: PaymentDialogOptions) => Promise<Record<string, string> | null>;

const PaymentDialogContext = createContext<PaymentDialogFn | null>(null);

interface Pending {
  opts: PaymentDialogOptions;
  resolve: (value: Record<string, string> | null) => void;
}

export function PaymentDialogProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const prompt: PaymentDialogFn = useCallback((opts) => {
    const initial: Record<string, string> = {};
    for (const f of opts.fields) initial[f.name] = f.defaultValue ?? '';
    setValues(initial);
    setErrors({});
    return new Promise<Record<string, string> | null>((resolve) => {
      setPending({ opts, resolve });
    });
  }, []);

  const cancel = () => {
    pending?.resolve(null);
    setPending(null);
  };

  const submit = () => {
    if (!pending) return;
    const errs: Record<string, string> = {};
    for (const f of pending.opts.fields) {
      if (f.required && !values[f.name]?.trim()) {
        errs[f.name] = `${f.label} is required`;
      }
    }
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    pending.resolve({ ...values });
    setPending(null);
  };

  const change = (name: string, val: string) => {
    setValues(prev => ({ ...prev, [name]: val }));
    setErrors(prev => { const n = { ...prev }; delete n[name]; return n; });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) submit();
    if (e.key === 'Escape') cancel();
  };

  return (
    <PaymentDialogContext.Provider value={prompt}>
      {children}
      {pending && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="payment-dialog-title"
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[280] flex items-center justify-center p-4"
          onKeyDown={handleKeyDown}
        >
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md">
            {/* Header */}
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-100">
              <h3 id="payment-dialog-title" className="font-semibold text-[#3d3128] text-base">
                {pending.opts.title}
              </h3>
              <button
                onClick={cancel}
                aria-label="Close"
                className="p-1.5 hover:bg-gray-100 rounded-full transition-colors text-gray-400 hover:text-gray-600"
              >
                <X size={16} />
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-4 space-y-4">
              {pending.opts.body && (
                <p className="text-sm text-gray-500">{pending.opts.body}</p>
              )}
              {pending.opts.fields.map(f => (
                <div key={f.name}>
                  <label className="block text-xs font-medium text-gray-600 mb-1.5">
                    {f.label}
                    {f.required && <span className="text-red-500 ml-0.5">*</span>}
                  </label>
                  {f.type === 'select' ? (
                    <select
                      value={values[f.name] ?? ''}
                      onChange={e => change(f.name, e.target.value)}
                      className={cn(
                        'w-full px-3 py-2.5 rounded-xl border text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/30',
                        errors[f.name] ? 'border-red-400' : 'border-gray-200',
                      )}
                    >
                      <option value="">Select…</option>
                      {f.options?.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  ) : f.type === 'textarea' ? (
                    <textarea
                      value={values[f.name] ?? ''}
                      onChange={e => change(f.name, e.target.value)}
                      placeholder={f.placeholder}
                      rows={3}
                      className={cn(
                        'w-full px-3 py-2.5 rounded-xl border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/30',
                        errors[f.name] ? 'border-red-400' : 'border-gray-200',
                      )}
                    />
                  ) : (
                    <input
                      type={f.type}
                      value={values[f.name] ?? ''}
                      onChange={e => change(f.name, e.target.value)}
                      placeholder={f.placeholder}
                      className={cn(
                        'w-full px-3 py-2.5 rounded-xl border text-sm focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/30',
                        errors[f.name] ? 'border-red-400' : 'border-gray-200',
                      )}
                    />
                  )}
                  {errors[f.name] && (
                    <p className="text-xs text-red-500 mt-1">{errors[f.name]}</p>
                  )}
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="flex gap-2 px-6 pb-6">
              <button
                onClick={cancel}
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                className="flex-1 px-4 py-2.5 rounded-xl bg-[#cc5a16] hover:bg-[#b34d12] text-white text-sm font-medium transition-colors"
              >
                {pending.opts.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </PaymentDialogContext.Provider>
  );
}

export function usePaymentDialog(): PaymentDialogFn {
  const ctx = useContext(PaymentDialogContext);
  if (!ctx) throw new Error('usePaymentDialog must be inside <PaymentDialogProvider>');
  return ctx;
}
