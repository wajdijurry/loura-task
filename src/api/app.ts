import Fastify from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Clock } from '../shared/clock.js';
import { AppError } from '../shared/errors.js';
import { TicketService } from '../tickets/ticket-service.js';
import { problemFromError, sendProblem } from './problem.js';
import { registerTicketRoutes } from './ticket-routes.js';

export interface BuildAppOptions {
  pool: Pool;
  clock: Clock;
  logger: Logger;
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    // Pino Logger is structurally compatible at runtime; Fastify's generics are stricter.
    loggerInstance: options.logger as FastifyBaseLogger,
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    // Above max ticket JSON size; enables controlled 413 without multi-MB payloads.
    bodyLimit: 64 * 1024,
  });

  const tickets = new TicketService(options.pool, options.clock);

  app.addHook('preParsing', async (request, _reply, payload) => {
    if (!['POST', 'PUT', 'PATCH'].includes(request.method)) {
      return payload;
    }
    const contentType = request.headers['content-type'];
    if (
      typeof contentType !== 'string' ||
      !contentType.toLowerCase().includes('application/json')
    ) {
      const error = new Error('Unsupported Media Type') as Error & {
        statusCode: number;
        code: string;
      };
      error.statusCode = 415;
      error.code = 'FST_ERR_CTP_INVALID_MEDIA_TYPE';
      throw error;
    }
    return payload;
  });

  app.get('/health', async () => ({ status: 'ok' }));

  // Test-only route to assert unexpected failures remain 500.
  if (process.env.NODE_ENV === 'test') {
    app.get('/v1/__unexpected', async () => {
      throw new Error('secret-internal-failure');
    });
  }

  registerTicketRoutes(app, tickets);

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) {
      return;
    }

    const problem = problemFromError(error, request);
    if (!(error instanceof AppError) && problem.status >= 500) {
      const name = error instanceof Error ? error.name : 'UnknownError';
      request.log.error({ err: { name } }, 'unhandled error');
    }
    sendProblem(reply, problem);
  });

  app.setNotFoundHandler((request, reply) => {
    sendProblem(reply, {
      type: 'https://httpstatuses.com/404',
      title: 'NOT_FOUND',
      status: 404,
      detail: 'Resource not found',
      instance: request.url,
    });
  });

  return app;
}
