import type { Job as DbJob, JobLog as DbJobLog } from '@blackshop/db';

export type JobStatus = 'waiting' | 'active' | 'completed' | 'failed';
export type JobLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Job = DbJob;
export type JobLog = DbJobLog;
