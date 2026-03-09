import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

// Do NOT wrap in fp() — must be encapsulated so content-type parser stays scoped
const webhookRoutes: FastifyPluginCallbackZod = (server, _opts, done) => {
  // Override JSON parsing for this scope only — gives raw Buffer as request.body
  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done_) => {
    done_(null, body);
  });

  server.post('/webhooks/agentmail', {}, async (request, reply) => {
    const rawBody = request.body as Buffer;
    const adapter = server.agentMailAdapter;
    if (!adapter) {
      return reply.code(500).send({ message: 'AgentMail not configured' });
    }

    const isValid = await adapter.verifyWebhook(rawBody, request.headers as Record<string, string>);
    if (!isValid) {
      request.log.warn('AgentMail webhook signature verification failed');
      return reply.code(401).send({ message: 'Invalid webhook signature' });
    }

    // Process synchronously (MVP — no queue yet); return 200 even on processing error
    try {
      const events = await adapter.parseWebhook(rawBody, request.headers as Record<string, string>);
      await server.webhookProcessor.processEvents('agentmail', events);
    } catch (err) {
      request.log.error({ err }, 'AgentMail webhook processing error');
    }

    return reply.code(200).send({ ok: true });
  });

  server.post('/webhooks/stripe', {}, async (request, reply) => {
    const rawBody = request.body as Buffer;
    const adapter = server.stripeAdapter;
    if (!adapter) {
      return reply.code(500).send({ message: 'Stripe not configured' });
    }

    const isValid = await adapter.verifyWebhook(rawBody, request.headers as Record<string, string>);
    if (!isValid) {
      request.log.warn('Stripe webhook signature verification failed');
      return reply.code(401).send({ message: 'Invalid webhook signature' });
    }

    // Process synchronously (MVP — no queue yet); return 200 even on processing error
    try {
      const events = await adapter.parseWebhook(rawBody, request.headers as Record<string, string>);
      await server.webhookProcessor.processEvents('stripe', events);
    } catch (err) {
      request.log.error({ err }, 'Stripe webhook processing error');
    }

    return reply.code(200).send({ ok: true });
  });

  done();
};

export default webhookRoutes;
