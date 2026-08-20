import { buildServer } from './server';
import { config } from '@media-downloader/config';
import { createLogger } from '@media-downloader/logger';

const logger = createLogger('api');

async function start() {
  try {
    const server = await buildServer(logger);
    
    await server.listen({
      port: config.API_PORT,
      host: config.API_HOST,
    });
    
    logger.info(`API Server listening on ${config.API_HOST}:${config.API_PORT}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

start();
