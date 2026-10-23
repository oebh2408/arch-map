import { Worker } from 'bullmq';
import { config } from '@shop/config';
import { sendReceipt } from './jobs/send-receipt';
import { syncStock } from './jobs/sync-stock';

new Worker('receipts', sendReceipt, { connection: { url: config.redisUrl } });
new Worker('stock', syncStock, { connection: { url: config.redisUrl } });
