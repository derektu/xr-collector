import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Collector } from '../core/collector.js';
import { CollectorError } from '../core/types.js';

export interface HttpAppOptions {
  collector: Collector;
  webRoot?: string;
}

const ERROR_STATUS: Record<CollectorError['code'], number> = {
  invalid_url: 400,
  invalid_request: 400,
  document_not_found: 404,
  no_subtitles: 422,
  video_unavailable: 422,
  capture_failed: 502,
  network_error: 503,
};

export async function createHttpApp(options: HttpAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'");
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof CollectorError) {
      void reply.status(ERROR_STATUS[error.code]).send({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({
      error: { code: 'internal_error', message: '發生未預期的錯誤。' },
    });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/api/documents', async () => ({ documents: await options.collector.list() }));

  app.get<{ Params: { id: string } }>('/api/documents/:id', async (request) => ({
    document: await options.collector.read(request.params.id),
  }));

  app.post<{ Body: { url?: unknown } }>('/api/youtube/collect', async (request) => {
    if (typeof request.body?.url !== 'string' || request.body.url.trim() === '') {
      throw new CollectorError('invalid_request', '請輸入 YouTube 影片網址。');
    }
    return options.collector.collect(request.body.url);
  });

  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, {
      root: path.resolve(options.webRoot),
      prefix: '/',
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        void reply.status(404).send({
          error: { code: 'not_found', message: '找不到這個 API。' },
        });
        return;
      }
      void reply.type('text/html').sendFile('index.html');
    });
  }

  return app;
}
