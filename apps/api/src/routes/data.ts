import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_SQL_LENGTH } from '@dbx/sql-engine';
import type { QueryHistoryRow, SavedQueryRow } from '@dbx/database';
import { noStore, parseBody, requireAuth, uuidParam } from '../http';

const historyQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
    search: z.string().max(200).optional(),
  })
  .strict();

const savedBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    sql: z.string().min(1).max(MAX_SQL_LENGTH),
    description: z.string().max(1000).nullable().optional(),
  })
  .strict();

const toHistory = (h: QueryHistoryRow) => ({
  id: h.id,
  executionId: h.executionId,
  sql: h.sql,
  status: h.status,
  operation: h.operation,
  resource: h.resource,
  durationMs: h.durationMs,
  resultRows: h.resultRows,
  affectedRows: h.affectedRows,
  apiCalls: h.apiCalls,
  errorCode: h.errorCode,
  createdAt: h.createdAt.toISOString(),
});

const toSaved = (q: SavedQueryRow) => ({
  id: q.id,
  name: q.name,
  description: q.description,
  sql: q.sql,
  createdAt: q.createdAt.toISOString(),
  updatedAt: q.updatedAt.toISOString(),
});

export async function dataRoutes(app: FastifyInstance): Promise<void> {
  const { history, saved } = app.services;

  app.get('/api/history', async (request, reply) => {
    noStore(reply);
    const auth = requireAuth(request);
    const q = parseBody(historyQuery, request.query);
    const items = await history.list(auth.user.id, q.limit, q.offset, q.search);
    return { items: items.map(toHistory) };
  });

  app.delete('/api/history', async (request) => {
    const auth = requireAuth(request);
    await history.clear(auth.user.id);
    return { ok: true };
  });

  app.get('/api/saved-queries', async (request, reply) => {
    noStore(reply);
    const auth = requireAuth(request);
    return { items: (await saved.list(auth.user.id)).map(toSaved) };
  });

  app.post('/api/saved-queries', async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseBody(savedBody, request.body);
    void reply.code(201);
    return { item: toSaved(await saved.create(auth.user.id, body)) };
  });

  app.get('/api/saved-queries/:id', async (request) => {
    const auth = requireAuth(request);
    const { id } = parseBody(uuidParam, request.params);
    return { item: toSaved(await saved.get(auth.user.id, id)) };
  });

  app.put('/api/saved-queries/:id', async (request) => {
    const auth = requireAuth(request);
    const { id } = parseBody(uuidParam, request.params);
    const body = parseBody(savedBody.partial(), request.body);
    return { item: toSaved(await saved.update(auth.user.id, id, body)) };
  });

  app.delete('/api/saved-queries/:id', async (request) => {
    const auth = requireAuth(request);
    const { id } = parseBody(uuidParam, request.params);
    await saved.remove(auth.user.id, id);
    return { ok: true };
  });

  app.post('/api/saved-queries/:id/duplicate', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parseBody(uuidParam, request.params);
    void reply.code(201);
    return { item: toSaved(await saved.duplicate(auth.user.id, id)) };
  });
}
