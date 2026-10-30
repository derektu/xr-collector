import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildInfo, TranscriptSearch } from '../../src/core/types.js';
import { startServer, type RunningServer } from '../../src/server/start.js';

const info: BuildInfo = {
  schemaVersion: 1, kind: 'packaged', version: '0.7.0', builtAt: '2026-10-25T09:00:00.000Z',
  commit: '1234567890123456789012345678901234567890', buildId: 'fixture-build',
  target: 'darwin-arm64', variant: 'chinese', sourceDirty: false,
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
    status: () => ({ state: 'ready', indexedDocuments: 0, lastRebuiltAt: null, message: null }),
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
  return startServer({ buildInfo: info, port: 0, ...(search ? { search } : {}) });
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

async function openSocket(port: number, bytes?: string): Promise<net.Socket> {
  const socket = net.connect(port, '127.0.0.1');
  sockets.push(socket);
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.on('connect', resolve));
  if (bytes) socket.write(bytes);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return socket;
}

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
    const closing = running.close();
    const closed = settled(closing);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed()).toBe(false);
    held.release();
    await closing;
    expect(held.finished()).toBe(true);
  });

  it('delivers the response of a keep-alive request under way and closes without waiting for its idle timeout', async () => {
    const held = heldSearch();
    const running = await server(held.search);
    const agent = new http.Agent({ keepAlive: true });
    agents.push(agent);
    const { response } = rebuild(running.port, agent);
    await held.running;
    const closing = running.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    held.release();
    expect(await response).toBe(200);
    await closing;
  }, 3000);

  it('closes with connections that carry no request', async () => {
    const running = await server();
    await openSocket(running.port);
    await openSocket(running.port, 'GET /api/search/status HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    await running.close();
  }, 3000);
});
