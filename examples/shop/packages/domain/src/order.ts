import type { OrderRow } from '@shop/db';
import type { Money } from './money';

export interface OrderInput {
  customerId: string;
  lines: { sku: string; quantity: number; price: Money }[];
}

export interface Order extends OrderInput {
  id: string;
  status: 'new' | 'paid' | 'shipped';
}

export const newOrder = (input: OrderInput): Order => ({ ...input, id: crypto.randomUUID(), status: 'new' });
export const fromRow = (row: OrderRow): Order => ({ id: row.id, customerId: row.customer_id, lines: [], status: row.status as Order['status'] });
