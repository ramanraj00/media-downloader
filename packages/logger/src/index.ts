import pino from 'pino';

export const createLogger = (service: string) => {
  const isDev = process.env.NODE_ENV !== 'production';

  return pino({
    name: service,
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: isDev
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
          },
        }
      : undefined,
  });
};

export { withJobContext } from './context';
