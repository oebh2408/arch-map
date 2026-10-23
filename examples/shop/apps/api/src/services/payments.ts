import Stripe from 'stripe';
import { config } from '@shop/config';

const stripe = new Stripe(config.paymentsKey);

export async function chargeOrder(orderId: string) {
  await stripe.paymentIntents.create({ amount: 1000, currency: 'usd', metadata: { orderId } });
}
