import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { submitJob, getJobStatus } from '../services/jobService';
import { AppError, PermanentError } from '@media-downloader/core';
import { ErrorType } from '@media-downloader/types';

const CreateJobSchema = z.object({
  url: z.string().url(),
  userId: z.number(),
  chatId: z.number(),
  statusMessageId: z.number().optional(),
});

type CreateJobRequest = FastifyRequest<{
  Body: z.infer<typeof CreateJobSchema>;
}>;

export default async function (server: FastifyInstance) {
  server.post('/', async (request: CreateJobRequest, reply) => {
    try {
      const data = CreateJobSchema.parse(request.body);
      const result = await submitJob(data);
      return reply.status(202).send(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw error; // Let fastify global handler catch it
      }
      throw error;
    }
  });

  server.get('/:jobId', async (request: FastifyRequest<{ Params: { jobId: string } }>, reply) => {
    const job = await getJobStatus(request.params.jobId);
    if (!job) {
      throw new PermanentError('Job not found', ErrorType.NOT_FOUND);
    }
    return job;
  });
}
