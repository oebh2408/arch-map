export const config = {
  port: Number(process.env.PORT ?? 3000),
  apiToken: process.env.API_TOKEN ?? '',
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',
  paymentsKey: process.env.PAYMENTS_KEY ?? '',
};
