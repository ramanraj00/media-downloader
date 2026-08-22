import { createLogger } from '@media-downloader/logger';
import { setupWorkers } from './worker';

import { processDownload, identityPool } from './engine';
export { processDownload, identityPool };
export { CobaltFallback } from './fallback';

const logger = createLogger('downloader');

async function start() {
  try {
    logger.info('Starting Downloader Workers...');
    const workers = await setupWorkers(logger);
    
    logger.info('Syncing identity pool to Redis...');
    const platforms = ['instagram', 'twitter', 'tiktok', 'reddit', 'mock'];
    await Promise.all(platforms.map(p => identityPool.syncToRedis(p)));
    
    // Background credential recovery sweeper
    setInterval(() => {
      Promise.all(platforms.map(p => identityPool.sweep(p))).catch(err => {
        logger.error({ err }, 'Error in identity pool sweeper loop');
      });
    }, 10000);
    
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
