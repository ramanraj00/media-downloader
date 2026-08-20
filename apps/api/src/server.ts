import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { Logger } from 'pino';
import healthRoutes from './routes/health';
import jobRoutes from './routes/jobs';
import { ErrorType } from '@media-downloader/types';

export async function buildServer(logger: Logger) {
  const server = Fastify({
    logger,
    disableRequestLogging: true, // We'll handle our own request logging
  });

  // Middleware
  await server.register(helmet);
  await server.register(cors);

  // Request logging
  server.addHook('onRequest', (request, reply, done) => {
    logger.info({ req: { method: request.method, url: request.url, id: request.id } }, 'Request received');
    done();
  });

  server.addHook('onResponse', (request, reply, done) => {
    logger.info(
      { res: { statusCode: reply.statusCode, time: reply.elapsedTime }, reqId: request.id },
      'Request completed'
    );
    done();
  });

  // Global Error Handler
  server.setErrorHandler((error, request, reply) => {
    logger.error(error);
    
    if (error.validation) {
      return reply.status(400).send({ error: 'Validation Error', details: error.validation });
    }

    if ('type' in error) {
      // It's our AppError
      const statusCode = error.type === ErrorType.NOT_FOUND ? 404 : 400;
      return reply.status(statusCode).send({ error: error.message, type: error.type });
    }

    reply.status(500).send({ error: 'Internal Server Error' });
  });

  // Routes
  server.register(healthRoutes, { prefix: '/health' });
  server.register(jobRoutes, { prefix: '/v1/jobs' });

  return server;
}
