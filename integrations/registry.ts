/**
 * Atithi-Setu — Multi-platform delivery integration: adapter registry
 * ════════════════════════════════════════════════════════════════════════
 *
 * Channel → adapter resolver. Bootstrapped once at server start in
 * server.ts:startServer(). Use `registerAdapter()` to add an implementation
 * and `getAdapter()` to look one up at request time.
 */

import type { ChannelId, DeliveryChannelAdapter } from './types';

const ADAPTERS = new Map<ChannelId, DeliveryChannelAdapter>();

export function registerAdapter(adapter: DeliveryChannelAdapter): void {
  if (ADAPTERS.has(adapter.channel)) {
    console.warn(`[integrations/registry] Adapter for ${adapter.channel} already registered — overwriting`);
  }
  ADAPTERS.set(adapter.channel, adapter);
}

/**
 * Returns the adapter for a channel, or throws if none is registered.
 * Use the throwing form when you've already validated the channel id is
 * in the union (e.g. inside a webhook handler that checked URL params).
 */
export function getAdapter(channel: ChannelId): DeliveryChannelAdapter {
  const a = ADAPTERS.get(channel);
  if (!a) throw new Error(`[integrations/registry] No adapter registered for channel ${channel}`);
  return a;
}

/**
 * Non-throwing variant — useful at boot time when iterating known channels
 * to skip ones that haven't been wired yet.
 */
export function tryGetAdapter(channel: ChannelId): DeliveryChannelAdapter | null {
  return ADAPTERS.get(channel) || null;
}

/**
 * Iterate over every registered adapter — used by smoke-test endpoints
 * and the SETTINGS UI to render channel cards even for channels with no
 * registered adapter (which appear as "Coming soon").
 */
export function listRegisteredChannels(): ChannelId[] {
  return Array.from(ADAPTERS.keys());
}

/** Clear the registry. Test-only. */
export function _resetAdaptersForTests(): void {
  ADAPTERS.clear();
}
