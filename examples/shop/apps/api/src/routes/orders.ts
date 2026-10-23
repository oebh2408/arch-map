import type { FastifyInstance } from 'fastify';
import { createOrder, listOrders } from '../services/orders';

export async function orderRoutes(app: FastifyInstance) {
  app.get('/orders', async () => listOrders());
  app.post('/orders', async (req) => createOrder(req.body as never));
}
