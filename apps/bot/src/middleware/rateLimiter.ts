import { Context, NextFunction } from 'grammy';
import { Logger } from 'pino';
import Redis from 'ioredis';
import { config } from '@media-downloader/config';

// Basic rate limiter middleware for the bot layer
export function rateLimiterMiddleware(logger: Logger) {
  const redis = new Redis(config.REDIS_URL);
  
  return async (ctx: Context, next: NextFunction) => {
    if (!ctx.from) return next();
    
    const key = `ratelimit:user:${ctx.from.id}:bot`;
    
    try {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.expire(key, 60); // 1 minute window
      }
      
      if (current > 15) { // Max 15 messages per minute
        if (current === 16) { // Only warn once
          await ctx.reply('⏳ You are sending messages too fast. Please wait a minute.');
        }
        return; // Drop message
      }
    } catch (err) {
      logger.warn({ err }, 'Redis rate limiter failed, bypassing');
    }
    
    await next();
  };
}
