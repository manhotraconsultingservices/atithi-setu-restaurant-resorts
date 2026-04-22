/**
 * useAlertChime — audible + visual alert hook
 *
 * Plays a gentle 2-tone chime (Web Audio API, no external files) every 4
 * seconds while `active` is true. Also prefixes the browser tab title with
 * a 🔔 so the alert is visible even when the tab isn't focused.
 *
 * Caps at 15 chimes (~60 s) to prevent infinite annoyance if staff walk
 * away. If the tab is hidden (page visibility API) chiming pauses.
 *
 * Usage:
 *   const pendingCount = waiterCalls.filter(c => c.status === 'pending').length;
 *   useAlertChime(pendingCount > 0 && alertsEnabled, { label: 'Waiter Call' });
 *
 * The hook does NOT render anything — pair it with a CSS class like
 * `alert-pulse` on the relevant card for the visual component.
 */

import { useEffect, useRef } from 'react';

interface Options {
  /** Label shown in the browser tab title while alert is active. */
  label?: string;
  /** Interval between chimes in ms. Default 4000. */
  intervalMs?: number;
  /** Max total chimes before auto-stop. Default 15. */
  maxChimes?: number;
}

// Single shared AudioContext across hook instances — browsers cap at ~6 per tab
let sharedAudioCtx: AudioContext | null = null;
function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (sharedAudioCtx) return sharedAudioCtx;
  const Ctor: typeof AudioContext | undefined =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  try { sharedAudioCtx = new Ctor(); } catch { sharedAudioCtx = null; }
  return sharedAudioCtx;
}

// Plays a short 2-tone chime. Returns immediately.
// Tones are in a pleasant C-major-ish interval (E5 → G5) at modest volume.
function playChime() {
  const ctx = getAudioContext();
  if (!ctx) return;
  // Chrome's autoplay policy requires a user gesture before audio plays.
  // If the context is suspended (tab was inactive), try to resume; if the
  // browser refuses, the chime is silently skipped.
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  const now = ctx.currentTime;
  const makeTone = (freq: number, startAt: number, durSec: number) => {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.25, startAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durSec);
    osc.connect(gain).connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + durSec + 0.05);
  };
  // Two-tone chime: first higher note, then lower.
  makeTone(659.25, now,        0.18);  // E5
  makeTone(523.25, now + 0.19, 0.22);  // C5 (softer resolution)
}

export function useAlertChime(active: boolean, options: Options = {}): void {
  const {
    label = 'Alert',
    intervalMs = 4000,
    maxChimes = 15,
  } = options;

  const chimeCountRef  = useRef<number>(0);
  const intervalRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const originalTitleRef = useRef<string>('');

  // Manage chime loop
  useEffect(() => {
    if (!active) {
      // Stop the loop and restore title
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      if (originalTitleRef.current && typeof document !== 'undefined') {
        document.title = originalTitleRef.current;
        originalTitleRef.current = '';
      }
      chimeCountRef.current = 0;
      return;
    }

    // Start loop
    if (typeof document !== 'undefined' && !originalTitleRef.current) {
      originalTitleRef.current = document.title;
      document.title = `🔔 ${label} · ${originalTitleRef.current}`;
    }

    // Play once immediately (if page is visible)
    if (typeof document === 'undefined' || !document.hidden) {
      playChime();
      chimeCountRef.current = 1;
    }

    intervalRef.current = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (chimeCountRef.current >= maxChimes) {
        if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
        return;
      }
      playChime();
      chimeCountRef.current += 1;
    }, intervalMs);

    return () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      if (originalTitleRef.current && typeof document !== 'undefined') {
        document.title = originalTitleRef.current;
        originalTitleRef.current = '';
      }
    };
  }, [active, label, intervalMs, maxChimes]);
}
