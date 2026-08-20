import { z } from 'zod';
import { config as dotenvConfig } from 'dotenv';
import path from 'path';

// Load .env from monorepo root if available
dotenvConfig({ path: path.resolve(__dirname, '../../../.env') });

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  BOT_TOKEN: z.string().min(1, 'Telegram Bot Token is required'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  DATABASE_URL: z.string().default('postgresql://media_dl:dev_password@localhost:5432/media_dl'),

  // Rate limits
  USER_MAX_ACTIVE_JOBS: z.coerce.number().default(3),
  PLATFORM_CONCURRENCY_INSTAGRAM: z.coerce.number().default(4),
  PLATFORM_CONCURRENCY_TWITTER: z.coerce.number().default(5),
  PLATFORM_CONCURRENCY_TIKTOK: z.coerce.number().default(5),
  PLATFORM_CONCURRENCY_REDDIT: z.coerce.number().default(6),
  GLOBAL_MAX_WORKERS: z.coerce.number().default(20),

  // Retry
  MAX_RETRIES: z.coerce.number().default(4),
  RETRY_BASE_DELAY_MS: z.coerce.number().default(2000),

  // Circuit breaker
  CB_FAILURE_THRESHOLD: z.coerce.number().default(5),
  CB_RESET_TIMEOUT_MS: z.coerce.number().default(60000),

  // Storage
  TEMP_DIR: z.string().default('/tmp/media-dl'),
  MAX_FILE_SIZE: z.coerce.number().default(50 * 1024 * 1024), // 50MB

  // Cache
  CACHE_TTL_SECONDS: z.coerce.number().default(86400),
  
  // API
  API_PORT: z.coerce.number().default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  API_URL: z.string().default('http://localhost:3000'),
});

export type Config = z.infer<typeof configSchema>;

let _config: Config | undefined;

export const loadConfig = (): Config => {
  if (!_config) {
    _config = configSchema.parse(process.env);
  }
  return _config;
};

export const config = loadConfig();
