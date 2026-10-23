import { findOrdersByCustomer } from '@shop/db';
import { OrderList } from '../../components/order-list';

export default async function Orders() {
  const orders = await findOrdersByCustomer('current');
  return <OrderList orders={orders} />;
}
