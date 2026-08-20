import { createBot } from './bot';
import { config } from '@media-downloader/config';
import { createLogger } from '@media-downloader/logger';

const logger = createLogger('bot');

async function start() {
  try {
    const bot = createBot(logger);
    
    // Graceful shutdown
    process.once('SIGINT', () => bot.stop());
    process.once('SIGTERM', () => bot.stop());

    logger.info('Bot starting (polling mode)...');
    await bot.start({
      onStart: (botInfo) => {
        logger.info(`Bot @${botInfo.username} started successfully`);
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to start bot');
    process.exit(1);
  }
}

start();
