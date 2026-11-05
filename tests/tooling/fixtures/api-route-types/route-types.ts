// Compiled by tests/tooling/api-route-table.test.ts and never run. Each `@ts-expect-error` line is a
// mismatch between a handler or a client and the API table that the typecheck must refuse; when the
// table stops refusing it, the directive is unused and the compile fails.
import type { FastifyInstance } from 'fastify';
import { API_ROUTES, type ResponseOf } from '../../../../src/core/api-routes.js';
import type { AgentConnection } from '../../../../src/core/device-types.js';
import type { DeviceUpdateStatus } from '../../../../src/core/update-types.js';
import type { TransferStatus } from '../../../../src/core/vault-types.js';
import { serve } from '../../../../src/server/api-route.js';

declare const app: FastifyInstance;
declare const update: DeviceUpdateStatus;
declare const connection: AgentConnection;
declare const transfer: TransferStatus;

// A handler answers the keys its route declares.
serve(app, API_ROUTES.update, async () => ({ update }));
// @ts-expect-error A renamed response key.
serve(app, API_ROUTES.update, async () => ({ updates: update }));
// @ts-expect-error A response key left out.
serve(app, API_ROUTES.resetAgentKey, async () => ({ connection }));
serve(app, API_ROUTES.vaultStatus, async () => transfer);
// @ts-expect-error A JSON route answers its response, not a reply it sent.
serve(app, API_ROUTES.vaultStatus, async (_request, reply) => reply.send(transfer));
// An event stream or a file route answers with the reply it sent.
serve(app, API_ROUTES.agentSkill, async (_request, reply) => reply.send('zip'));

// A client reads the keys its route declares.
declare const answer: ResponseOf<typeof API_ROUTES.update>;
answer.update satisfies DeviceUpdateStatus;
// @ts-expect-error A key the route does not answer.
void answer.updates;
