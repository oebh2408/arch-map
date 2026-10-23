import type { Order } from '@shop/domain';
import { Card } from '@shop/ui';

export function OrderList({ orders }: { orders: Order[] }) {
  return <Card title={`${orders.length} orders`} />;
}
