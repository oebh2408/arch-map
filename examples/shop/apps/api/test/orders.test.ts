import { newOrder } from '@shop/domain';
import { createOrder } from '../src/services/orders';

test('creates an order', async () => {
  await createOrder({ customerId: 'c1', lines: [] });
  newOrder({ customerId: 'c1', lines: [] });
});
