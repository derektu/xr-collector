import type { JobView } from '../../shared/jobs/job-types.js';
import { ApiError } from './api-error.js';

export async function readFilteredJob(getJob: (id: string) => Promise<JobView>, id: string): Promise<JobView | null> {
  try {
    return await getJob(id);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'job_not_found') return null;
    throw error;
  }
}
