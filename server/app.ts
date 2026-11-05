import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { registerAuth, registerRequestAuth } from './auth.ts';
import { registerCatalog } from './catalog.ts';
import { HttpError } from './common.ts';
import { createStore, type Store } from './db.ts';
import { registerFiles, type StorageAdapter } from './files.ts';
import { registerFinance } from './finance.ts';
import { registerTasks } from './tasks.ts';
import { registerTimetable } from './timetable.ts';

export async function buildApp({db: suppliedDb, storage, logger = false}: {
  db?: Store; storage?: StorageAdapter; logger?: boolean;
} = {}) {
  const db = suppliedDb ?? createStore();
  const trustedProxies = (process.env.TRUST_PROXY ?? '127.0.0.1,::1').split(',').map(proxy => proxy.trim()).filter(Boolean);
  const app = Fastify({
    trustProxy: trustedProxies.length ? trustedProxies : false,
    logger: logger ? {redact:['req.headers.cookie', 'res.headers.set-cookie']} : false,
  });
  if (!suppliedDb) app.addHook('onClose', async () => db.close());
  await app.register(cookie);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send({message: error.message});
    const status = (error as {statusCode?:number}).statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({message: error instanceof Error ? error.message : '请求无效'});
    }
    request.log.error({err: error}, 'API request failed');
    return reply.code(500).send({message:'服务器暂时无法完成请求'});
  });
  registerRequestAuth(app, db);
  await registerFiles(app, db, storage);
  await registerAuth(app, db);
  await registerTasks(app, db);
  await registerFinance(app, db);
  await registerCatalog(app, db);
  await registerTimetable(app, db);
  return app;
}
