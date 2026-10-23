import pg from 'pg';
import { config } from '@shop/config';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });
