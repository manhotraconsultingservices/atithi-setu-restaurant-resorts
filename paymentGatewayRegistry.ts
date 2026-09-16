// The gateways the product can talk to. Adding one = import its adapter and add
// a line here; the settings page, link creation and webhooks all read this list.
import type { GatewayId, PaymentGateway } from './paymentGateway.ts';
import { RazorpayGateway } from './razorpayGateway.ts';

const GATEWAYS: Partial<Record<GatewayId, PaymentGateway>> = {
  RAZORPAY: new RazorpayGateway(),
};

export function getGateway(id: string): PaymentGateway | null {
  return GATEWAYS[String(id || '').toUpperCase() as GatewayId] || null;
}

export function listGateways(): PaymentGateway[] {
  return Object.values(GATEWAYS) as PaymentGateway[];
}
