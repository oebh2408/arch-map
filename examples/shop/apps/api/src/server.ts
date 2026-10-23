import Fastify from 'fastify';
import { config } from '@shop/config';
import { auth } from './plugins/auth';
import { orderRoutes } from './routes/orders';
import { paymentRoutes } from './routes/payments';

const app = Fastify();
app.register(auth);
app.register(orderRoutes);
app.register(paymentRoutes);
app.listen({ port: config.port });
