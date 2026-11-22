import { describe, expect, it } from 'vitest';
import type { JobView } from '../../../src/shared/jobs/job-types.js';
import { ApiError } from '../../../src/transport/web/api-error.js';
import { readFilteredJob } from '../../../src/transport/web/filtered-job.js';

describe('filtered job', () => {
  it('treats a job no longer kept as the answer so the job filter counts as caught up, and rejects other failures so the read runs again', async () => {
    const kept = { id: 'job-1' } as JobView;
    await expect(readFilteredJob(async () => kept, 'job-1')).resolves.toBe(kept);
    await expect(readFilteredJob(async () => { throw new ApiError('gone', 'job_not_found'); }, 'job-1')).resolves.toBeNull();
    const offline = new ApiError('unreachable', 'network_error');
    await expect(readFilteredJob(async () => { throw offline; }, 'job-1')).rejects.toBe(offline);
    const broken = new Error('boom');
    await expect(readFilteredJob(async () => { throw broken; }, 'job-1')).rejects.toBe(broken);
  });
});
