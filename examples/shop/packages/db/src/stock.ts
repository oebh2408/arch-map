import { pool } from './client';

export async function updateStock(sku: string, quantity: number) {
  await pool.query('update stock set quantity = $2 where sku = $1', [sku, quantity]);
}
