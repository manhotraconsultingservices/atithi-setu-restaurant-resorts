import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { resetKey?: string | number | null; children: ReactNode; }
interface State { error: Error | null; }

// Catches a render/lifecycle error thrown by the ACTIVE TAB so one bad row (e.g. a
// menu item with a null field) shows a contained message instead of blanking the
// whole app (reported: "Restaurant → Menu white screen"). Resets automatically when
// the user switches tabs (resetKey) and offers Try again / Reload.
//
// NOTE: this project ships no @types/react (React 19 + allowJs infers the runtime
// module), so the inherited props/state/setState members are declared explicitly
// for the type-checker. `declare` emits nothing — runtime is React's own Component.
export class TabErrorBoundary extends Component<Props, State> {
  declare props: Readonly<Props>;
  declare state: Readonly<State>;
  declare setState: (next: Partial<State> | ((prev: State) => Partial<State>)) => void;

  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[TabErrorBoundary] page crashed:', error, info?.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const message = String(this.state.error?.message || this.state.error);
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
        <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center text-3xl">⚠️</div>
        <h3 className="text-xl font-bold text-[#3d3128]">This page hit an error</h3>
        <p className="text-sm text-[#9c8e85] max-w-md">
          Something on this page could not be displayed. Try again, or reload the app.
          If it keeps happening, share the details below with support.
        </p>
        <details className="text-xs text-[#9c8e85] max-w-lg">
          <summary className="cursor-pointer">Technical details</summary>
          <pre className="mt-2 text-left whitespace-pre-wrap break-words">{message}</pre>
        </details>
        <div className="flex gap-2">
          <button type="button" onClick={() => this.setState({ error: null })}
            className="px-4 py-2 rounded-xl text-sm font-bold border border-[#cc5a16]/20 text-[#6b5d52] hover:bg-[#faf7f2]">
            Try again
          </button>
          <button type="button" onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-xl text-sm font-bold bg-[#cc5a16] text-white hover:bg-[#b34e12]">
            Reload app
          </button>
        </div>
      </div>
    );
  }
}
