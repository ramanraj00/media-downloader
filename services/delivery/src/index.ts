import { createLogger } from '@media-downloader/logger';
import { setupWorker } from './worker';

const logger = createLogger('delivery');

async function start() {
  try {
    logger.info('Starting Delivery Worker...');
    const worker = await setupWorker(logger);
    
    process.once('SIGINT', async () => {
      logger.info('Shutting down worker...');
      await worker.close();
      process.exit(0);
    });
    
    process.once('SIGTERM', async () => {
      logger.info('Shutting down worker...');
      await worker.close();
      process.exit(0);
    });

  } catch (error) {
    logger.error({ err: error }, 'Failed to start delivery service');
    process.exit(1);
  }
}

start();
