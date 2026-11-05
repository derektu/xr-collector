// Closing the HTTP server, as quit and restart do: it waits for a handler under way even after its
// client left, delivers a keep-alive response in progress, and does not hang on idle connections,
// open event streams or waiting change reads. A close that hangs leaves quit or restart stuck.
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ChangeFeed } from '../../src/core/change-feed.js';
import type { BuildInfo } from '../../src/core/update-types.js';
import type { TranscriptSearch } from '../../src/core/search-types.js';
import { startServer, type RunningServer } from '../../src/server/start.js';
import { eventually } from '../support/wait.js';
import { PRODUCT_SOURCES } from '../support/product-sources.js';

const info: BuildInfo = {
  schemaVersion: 1, kind: 'packaged', version: '0.7.0', builtAt: '2026-10-25T09:00:00.000Z',
  commit: '1234567890123456789012345678901234567890', buildId: 'fixture-build',
  target: 'darwin-arm64', sourceDirty: false,
};

const sockets: net.Socket[] = [];
const agents: http.Agent[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const agent of agents.splice(0)) agent.destroy();
});

/** A search whose rebuild runs until the test releases it. */
function heldSearch() {
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let finished = false;
  const search: TranscriptSearch = {
    status: () => ({ state: 'ready', indexedDocuments: 0, lastRebuiltAt: null }),
    index: async () => undefined,
    remove: async () => undefined,
    search: async () => ({ results: [], total: 0 }) as never,
    rebuild: () => {
      started();
      return new Promise<void>((resolve) => { release = () => { finished = true; resolve(); }; });
    },
  };
  return { search, running, release: () => release(), finished: () => finished };
}

async function server(search?: TranscriptSearch): Promise<RunningServer> {
  return startServer({ sources: PRODUCT_SOURCES, buildInfo: info, port: 0, ...(search ? { search } : {}) });
}

function rebuild(port: number, agent?: http.Agent): { request: http.ClientRequest; response: Promise<number> } {
  const request = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/api/search/rebuild', ...(agent ? { agent } : {}) });
  const response = new Promise<number>((resolve, reject) => {
    request.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    request.on('error', reject);
  });
  request.end();
  return { request, response };
}

const connections = (running: RunningServer) => new Promise<number>((resolve, reject) => {
  running.app.server.getConnections((error, count) => error ? reject(error) : resolve(count));
});

/** Opens a connection and returns once the server holds it. */
async function openSocket(running: RunningServer, bytes?: string): Promise<net.Socket> {
  const before = await connections(running);
  const socket = net.connect(running.port, '127.0.0.1');
  sockets.push(socket);
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.on('connect', resolve));
  if (bytes) socket.write(bytes);
  await eventually(async () => expect(await connections(running)).toBe(before + 1));
  return socket;
}

/** Resolves once the server receives a request for `path`. */
const arrives = (running: RunningServer, path: string) => new Promise<void>((resolve) => {
  running.app.server.on('request', (request: http.IncomingMessage) => { if (request.url?.startsWith(path)) resolve(); });
});

const settled = (promise: Promise<unknown>) => {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  return () => done;
};

describe('HTTP server close', () => {
  it('waits for an accepted handler whose client disconnected, then closes', async () => {
    const held = heldSearch();
    const running = await server(held.search);
    const { request, response } = rebuild(running.port);
    response.catch(() => undefined);
    await held.running;
    request.destroy();
    const serverClosed = once(running.app.server, 'close');
    const closing = running.close();
    const closed = settled(closing);
    // Past the listener's close, a close that did not wait for the handler has only callbacks left.
    await serverClosed;
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed()).toBe(false);
    held.release();
    await closing;
    expect(held.finished()).toBe(true);
  });

  // Fastify keeps an idle connection for 72 seconds, past the test bound, so a close that waited for it fails.
  it('delivers the response of a keep-alive request under way and closes without waiting for its idle timeout', async () => {
    const held = heldSearch();
    const running = await server(held.search);
    const agent = new http.Agent({ keepAlive: true });
    agents.push(agent);
    const { response } = rebuild(running.port, agent);
    await held.running;
    const closing = running.close();
    await eventually(() => expect(running.app.server.listening).toBe(false));
    held.release();
    expect(await response).toBe(200);
    await closing;
  });

  it('closes with connections that carry no request', async () => {
    const running = await server();
    await openSocket(running);
    await openSocket(running, 'GET /api/search/status HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    await running.close();
  });

  it('closes while event streams and waiting change reads are open', async () => {
    const changes = new ChangeFeed();
    const running = await startServer({ sources: PRODUCT_SOURCES, buildInfo: info, port: 0, changes });
    const stream = await fetch(`${running.url}/api/events`);
    expect(stream.status).toBe(200);
    const ended = stream.text();
    const arrived = arrives(running, '/api/changes');
    const waiting = fetch(`${running.url}/api/changes?after=${changes.revision}&wait=30`).then((response) => response.json());
    await arrived;
    await running.close();
    expect(await ended).toContain('event: hello');
    expect(await waiting).toMatchObject({ batches: [] });
  });
});
