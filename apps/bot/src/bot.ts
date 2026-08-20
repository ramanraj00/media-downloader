import { Bot, Context } from 'grammy';
import { config } from '@media-downloader/config';
import { Logger } from 'pino';
import { startCommand, helpCommand } from './handlers/start';
import { downloadHandler } from './handlers/download';
import { rateLimiterMiddleware } from './middleware/rateLimiter';
import { errorHandler } from './middleware/errorHandler';

export function createBot(logger: Logger): Bot {
  const bot = new Bot(config.BOT_TOKEN);

  // Error handling middleware
  bot.catch(errorHandler(logger));

  // Rate limiting middleware
  bot.use(rateLimiterMiddleware(logger));

  // Commands
  bot.command('start', startCommand);
  bot.command('help', helpCommand);

  // Message handler for URLs
  bot.on('message:text', downloadHandler(logger));

  return bot;
}
