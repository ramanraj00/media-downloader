import { createLogger } from '@media-downloader/logger';
import { setupWorkers } from './worker';

const logger = createLogger('downloader');

async function start() {
  try {
    logger.info('Starting Downloader Workers...');
    const workers = await setupWorkers(logger);
    
    // Graceful shutdown
    process.once('SIGINT', async () => {
      logger.info('Shutting down workers...');
      await Promise.all(workers.map(w => w.close()));
      process.exit(0);
    });
    
    process.once('SIGTERM', async () => {
      logger.info('Shutting down workers...');
      await Promise.all(workers.map(w => w.close()));
      process.exit(0);
    });

  } catch (error) {
    logger.error({ err: error }, 'Failed to start downloader service');
    process.exit(1);
  }
}

start();
