import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, ValidationError } from '../shared/errors.js';
import type { ZodError } from 'zod';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  errors?: unknown;
}

export function sendProblem(reply: FastifyReply, problem: ProblemDetails): FastifyReply {
  return reply
    .status(problem.status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send(problem);
}

function isFastifyHttpError(
  error: unknown,
): error is Error & { statusCode: number; code?: string } {
  return (
    error instanceof Error &&
    'statusCode' in error &&
    typeof (error as { statusCode: unknown }).statusCode === 'number'
  );
}

function clientProblem(
  status: number,
  title: string,
  detail: string,
  request: FastifyRequest,
): ProblemDetails {
  return {
    type: `https://httpstatuses.com/${status}`,
    title,
    status,
    detail,
    instance: request.url,
  };
}

/**
 * Map framework/client errors to controlled problem+json responses.
 * Never expose stacks, SQL, credentials, raw provider text, or request bodies.
 */
export function problemFromError(error: unknown, request: FastifyRequest): ProblemDetails {
  if (error instanceof AppError) {
    return {
      type: `https://httpstatuses.com/${error.status}`,
      title: error.code,
      status: error.status,
      detail: error.message,
      instance: request.url,
      ...(error.details ? { errors: error.details } : {}),
    };
  }

  if (isFastifyHttpError(error)) {
    const status = error.statusCode;
    const code = error.code ?? '';

    if (status === 400 || code.includes('INVALID_JSON') || code.includes('VALIDATION')) {
      return clientProblem(400, 'VALIDATION_ERROR', 'Request validation failed', request);
    }
    if (status === 413 || code.includes('BODY_TOO_LARGE')) {
      return clientProblem(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large', request);
    }
    if (status === 415 || code.includes('INVALID_MEDIA_TYPE') || code.includes('CONTENT_TYPE')) {
      return clientProblem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported content type', request);
    }
    if (status === 404) {
      return clientProblem(404, 'NOT_FOUND', 'Resource not found', request);
    }
    if (status >= 400 && status < 500) {
      return clientProblem(status, 'CLIENT_ERROR', 'Client error', request);
    }
  }

  return {
    type: 'https://httpstatuses.com/500',
    title: 'INTERNAL_ERROR',
    status: 500,
    detail: 'An unexpected error occurred',
    instance: request.url,
  };
}

export function validationProblem(error: ZodError, request: FastifyRequest): ProblemDetails {
  const appError = new ValidationError('Request validation failed', {
    issues: error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  });
  return problemFromError(appError, request);
}
