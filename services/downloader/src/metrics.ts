import Fastify from 'fastify';
import client from 'prom-client';
import { createLogger } from '@media-downloader/logger';
import { config } from '@media-downloader/config';

const logger = createLogger('metrics');

// Define metrics
export const jobsEnqueued = new client.Counter({
  name: 'jobs_enqueued_total',
  help: 'Total number of jobs enqueued',
  labelNames: ['platform']
});

export const jobsCompleted = new client.Counter({
  name: 'jobs_completed_total',
  help: 'Total number of jobs completed',
  labelNames: ['platform']
});

export const jobsFailed = new client.Counter({
  name: 'jobs_failed_total',
  help: 'Total number of jobs failed permanently',
  labelNames: ['platform']
});

export const admissionActive = new client.Gauge({
  name: 'platform_admission_active',
  help: 'Number of active jobs inside admission control',
  labelNames: ['platform']
});

export const credentialLeasesActive = new client.Gauge({
  name: 'credential_leases_active',
  help: 'Number of active credential leases',
  labelNames: ['platform']
});

// Enable default system metrics (CPU, RAM, Event Loop)
client.collectDefaultMetrics();

export async function startMetricsServer(port: number) {
  const server = Fastify({ disableRequestLogging: true });

  server.get('/metrics', async (request, reply) => {
    reply.header('Content-Type', client.register.contentType);
    return client.register.metrics();
  });

  try {
    await server.listen({ port, host: '0.0.0.0' });
    logger.info(`Prometheus Metrics server listening on port ${port}`);
  } catch (err) {
    logger.error({ err }, 'Failed to start metrics server');
  }
}
