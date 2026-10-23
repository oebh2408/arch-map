import type { FastifyInstance } from 'fastify';
import { config } from '@shop/config';

export async function auth(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => {
    if (req.headers.authorization !== `Bearer ${config.apiToken}`) throw new Error('unauthorized');
  });
}
