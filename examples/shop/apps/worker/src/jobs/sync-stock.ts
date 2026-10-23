import { updateStock } from '@shop/db';

export async function syncStock(job: { data: { sku: string; quantity: number } }) {
  await updateStock(job.data.sku, job.data.quantity);
}
