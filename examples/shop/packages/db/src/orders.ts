import type { Order } from '@shop/domain';
import { pool } from './client';

export interface OrderRow {
  id: string;
  customer_id: string;
  status: string;
  email: string;
}

export async function findOrder(id: string): Promise<OrderRow> {
  const { rows } = await pool.query('select * from orders where id = $1', [id]);
  return rows[0];
}

export async function findOrdersByCustomer(customerId: string): Promise<Order[]> {
  const { rows } = await pool.query('select * from orders where customer_id = $1', [customerId]);
  return rows;
}

export async function insertOrder(order: Order) {
  await pool.query('insert into orders (id, customer_id, status) values ($1, $2, $3)', [order.id, order.customerId, order.status]);
}

export async function markPaid(id: string) {
  await pool.query("update orders set status = 'paid' where id = $1", [id]);
}
