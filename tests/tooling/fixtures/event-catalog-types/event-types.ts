// Compiled by tests/tooling/event-catalog.test.ts and never run. Each `@ts-expect-error` line is an
// event kind the event catalog does not list, which the typecheck must refuse; when it stops refusing
// it, the directive is unused and the compile fails.
import type { EventRecorder, JobEvent } from '../../../../src/core/types.js';
import type { UpdateServiceOptions } from '../../../../src/updates/update-service.js';

declare const recorder: EventRecorder;
const subject = { message: '', vaultPath: null, jobId: null } as const;

// An emitter records the kinds the catalog lists, and a pacing group's cooldown under the group's name.
recorder.event({ ...subject, eventType: 'document.saved' });
recorder.event({ ...subject, eventType: 'fake.rate_limited', severity: 'warning' });
// @ts-expect-error A new kind left out of the catalog.
recorder.event({ ...subject, eventType: 'document.archived' });
// @ts-expect-error A misspelled kind.
recorder.event({ ...subject, eventType: 'job.complete' });

// The desktop emitters that record device events name catalog kinds too.
declare const update: NonNullable<UpdateServiceOptions['event']>;
update('info', 'device.update_ready', '');
// @ts-expect-error A device event left out of the catalog.
update('info', 'device.update_postponed', '');

// A reader that branches on a kind can only name one that exists.
declare const event: JobEvent;
switch (event.eventType) {
  case 'job.started': break;
  // @ts-expect-error A misspelled kind never matches.
  case 'job.strated': break;
  default: break;
}
