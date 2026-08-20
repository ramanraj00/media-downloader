import { Logger } from 'pino';

export const withJobContext = (logger: Logger, jobId: string, platform?: string) => {
  return logger.child({ jobId, platform });
};
