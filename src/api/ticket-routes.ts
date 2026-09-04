import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TicketService } from '../tickets/ticket-service.js';
import { NotFoundError } from '../shared/errors.js';
import { sendProblem, validationProblem } from './problem.js';
import { createTicketBodySchema, listTicketsQuerySchema, ticketIdParamSchema } from './schemas.js';

export function registerTicketRoutes(
  app: {
    post: (path: string, handler: (req: FastifyRequest, reply: FastifyReply) => unknown) => unknown;
    get: (path: string, handler: (req: FastifyRequest, reply: FastifyReply) => unknown) => unknown;
  },
  tickets: TicketService,
): void {
  app.post('/v1/tickets', async (request, reply) => {
    const parsed = createTicketBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, validationProblem(parsed.error, request));
    }

    const result = await tickets.createTicket(parsed.data);

    if (result.kind === 'created') {
      return reply
        .status(202)
        .header('Location', `/v1/tickets/${result.ticket.id}`)
        .send(result.ticket);
    }

    return reply.status(200).header('Idempotent-Replayed', 'true').send(result.ticket);
  });

  app.get('/v1/tickets/:id', async (request, reply) => {
    const parsed = ticketIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return sendProblem(reply, validationProblem(parsed.error, request));
    }

    const ticket = await tickets.getTicket(parsed.data.id);
    if (!ticket) {
      throw new NotFoundError(`Ticket ${parsed.data.id} not found`);
    }
    return ticket;
  });

  app.get('/v1/tickets', async (request, reply) => {
    const parsed = listTicketsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(reply, validationProblem(parsed.error, request));
    }

    const result = await tickets.listTickets(parsed.data);
    const totalPages = result.total === 0 ? 0 : Math.ceil(result.total / result.pageSize);

    return {
      data: result.tickets,
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages,
      },
    };
  });
}
