import type { FastifyInstance } from 'fastify';
import { markPaid } from '@shop/db';
import { chargeOrder } from '../services/payments';

export async function paymentRoutes(app: FastifyInstance) {
  app.post('/payments', async (req) => {
    const { orderId } = req.body as { orderId: string };
    await chargeOrder(orderId);
    await markPaid(orderId);
  });
}
