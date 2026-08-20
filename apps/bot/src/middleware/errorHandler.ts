import { BotError, Context } from 'grammy';
import { Logger } from 'pino';

export function errorHandler(logger: Logger) {
  return async (err: BotError<Context>) => {
    const ctx = err.ctx;
    logger.error({
      err: err.error,
      update_id: ctx.update.update_id,
      user_id: ctx.from?.id
    }, 'Error while handling update');
  };
}
