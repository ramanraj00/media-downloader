import { pgTable, serial, varchar, text, timestamp, integer, uuid, bigint, index, uniqueIndex, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  telegramId: bigint('telegram_id', { mode: 'number' }).notNull().unique(),
  username: varchar('username', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow(),
  totalJobs: integer('total_jobs').notNull().default(0),
  activeJobs: integer('active_jobs').notNull().default(0),
});

export const jobs = pgTable('jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  url: text('url').notNull(),
  normalizedUrl: text('normalized_url').notNull(),
  urlHash: varchar('url_hash', { length: 64 }).notNull(),
  platform: varchar('platform', { length: 20 }).notNull(),
  status: varchar('status', { length: 30 }).notNull().default('received'),
  chatId: bigint('chat_id', { mode: 'number' }).notNull(),
  statusMessageId: integer('status_message_id'),
  retryCount: integer('retry_count').default(0),
  error: text('error'),
  telegramFileId: varchar('telegram_file_id', { length: 255 }),
  telegramMessageId: integer('telegram_message_id'),
  contentHash: varchar('content_hash', { length: 64 }),
  fileSize: integer('file_size'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  completedAt: timestamp('completed_at'),
}, (table) => {
  return {
    urlHashIdx: uniqueIndex('idx_jobs_url_hash').on(table.urlHash),
  };
});

export const media = pgTable('media', {
  id: uuid('id').defaultRandom().primaryKey(),
  jobId: uuid('job_id').references(() => jobs.id).unique(),
  contentHash: varchar('content_hash', { length: 64 }),
  filePath: text('file_path'),
  objectKey: text('object_key'),
  mimeType: varchar('mime_type', { length: 50 }),
  fileSize: integer('file_size'),
  duration: integer('duration'),
  width: integer('width'),
  height: integer('height'),
  codec: varchar('codec', { length: 20 }),
  createdAt: timestamp('created_at').defaultNow(),
  expiresAt: timestamp('expires_at'),
}, (table) => {
  return {
    contentHashIdx: index('idx_media_content_hash').on(table.contentHash),
  };
});

export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  eventType: varchar('event_type', { length: 50 }).notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  payload: jsonb('payload').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  availableAt: timestamp('available_at').notNull().defaultNow(),
  publishedAt: timestamp('published_at'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => {
  return {
    outboxPendingIdx: index('idx_outbox_pending').on(table.status, table.availableAt),
  };
});
