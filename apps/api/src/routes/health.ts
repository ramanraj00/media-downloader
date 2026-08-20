import { FastifyInstance } from 'fastify';
import { db } from '@media-downloader/db';
import Redis from 'ioredis';
import { config } from '@media-downloader/config';
import { sql } from 'drizzle-orm';

export default async function (server: FastifyInstance) {
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  server.get('/', async (request, reply) => {
    // Basic health check
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  server.get('/ready', async (request, reply) => {
    try {
      // Check Postgres
      await db.execute(sql`SELECT 1`);
      
      // Check Redis
      await redis.ping();

      return { status: 'ready', postgres: 'ok', redis: 'ok' };
    } catch (error) {
      server.log.error(error, 'Readiness check failed');
      return reply.status(503).send({ status: 'not_ready', error: String(error) });
    }
  });

  server.addHook('onClose', async () => {
    await redis.quit();
  });
}
