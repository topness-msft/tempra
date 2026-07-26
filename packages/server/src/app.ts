import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { config, dbPath } from './config.js';
import { openDb, type Db } from './db.js';
import { registerApi } from './api.js';

export interface BuildAppOptions {
  logger?: boolean;
  serveStatic?: boolean;
  /** Injected by tests so each suite gets an isolated in-memory database. */
  db?: Db;
}

export const buildApp = async (opts: BuildAppOptions = {}): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  const db = opts.db ?? openDb(dbPath());
  app.addHook('onClose', async () => {
    if (!opts.db) db.close();
  });

  await app.register(fastifyCookie, { secret: config.sessionSecret });

  app.get('/health', async () => ({
    ok: true,
    commit: config.commit,
    time: new Date().toISOString(),
  }));

  await registerApi(app, { db });

  const serveStatic = opts.serveStatic ?? true;
  if (serveStatic && config.webDist) {
    await app.register(fastifyStatic, { root: config.webDist });
    // The PWA is a single page; unknown non-API paths fall back to the shell
    // so a deep link or a cold offline start still boots the app.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/hooks')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
};
