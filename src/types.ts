import type { Server } from 'node:http'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'cancelled'

export interface BackoffOptions {
  type: 'fixed' | 'exponential'
  delayMs: number
  maxDelayMs?: number
}

export interface JobOptions {
  /** Higher numbers run first. Equal priorities keep FIFO order. */
  priority?: number
  /** Delay this job by the given number of milliseconds. */
  delayMs?: number
  /** Total attempts, including the first run. Defaults to 1. */
  attempts?: number
  /** Delay between retries. Defaults to exponential backoff starting at 1 second. */
  backoff?: BackoffOptions
  /** Reuse the existing job ID while a job with this key is retained. */
  idempotencyKey?: string
}

export interface QueueOptions {
  db: BroccoliDatabase
  /** BroccoliDB table prefix. Use a stable, unique value for this application. */
  namespace?: string
  defaultJobOptions?: JobOptions
  /** Terminal job retention window. Defaults to 7 days. */
  retentionMs?: number
  /** Coalesce concurrent queue writes before syncing the WAL. Defaults to 0 ms. */
  flushBatchDelayMs?: number
  /** Maximum UTF-8 JSON size of one job payload. Defaults to 1 MiB. */
  maxJobDataBytes?: number
  /** Maximum UTF-8 JSON size of one handler result. Defaults to 1 MiB. */
  maxJobResultBytes?: number
  /** Maximum jobs accepted by one addBulk() call. Defaults to 1,000. */
  maxBulkItems?: number
  /** Maximum combined payload bytes accepted by one addBulk() call. Defaults to 16 MiB. */
  maxBulkBytes?: number
  /** How often retention maintenance checks for expired terminal jobs. Defaults to 5 seconds. */
  maintenanceIntervalMs?: number
  /** Maximum jobs removed in one maintenance pass. Defaults to 25,000. */
  maintenanceBatchSize?: number
  /** Maximum bounded batches in one maintenance pass. Defaults to 5. */
  maintenanceMaxBatches?: number
}

export interface WorkerOptions {
  /** Maximum concurrently running handlers. Defaults to 1. */
  concurrency?: number
  /** Maximum jobs claimed in one persistence batch. Defaults to 32. */
  batchSize?: number
  /** Idle polling interval. New local jobs wake workers immediately. Defaults to 100 ms. */
  pollingIntervalMs?: number
  /** Lease duration; workers renew it while handlers run. Defaults to 30 seconds. */
  leaseDurationMs?: number
  /** Stable label shown in job inspection. Defaults to a generated worker ID. */
  workerId?: string
}

export interface WorkerContext {
  signal: AbortSignal
  /** Extend this job's lease immediately. The worker also renews leases automatically. */
  heartbeat(): Promise<boolean>
}

export interface JobError {
  name: string
  message: string
  stack?: string
  code?: string | number
}

export interface Job<T = JsonValue, R = JsonValue> {
  id: string
  queueName: string
  data: T
  state: JobState
  priority: number
  createdAt: number
  updatedAt: number
  availableAt: number
  processedAt?: number
  finishedAt?: number
  attemptsMade: number
  maxAttempts: number
  backoff: BackoffOptions
  workerId?: string
  leaseExpiresAt?: number
  returnValue?: R
  lastError?: JobError
  idempotencyKey?: string
}

export interface AddJob<T = JsonValue> {
  name: string
  data: T
  options?: JobOptions
}

export interface QueueStateCounts {
  waiting: number
  delayed: number
  active: number
  completed: number
  failed: number
  cancelled: number
}

export interface QueueSummary {
  name: string
  paused: boolean
  createdAt: number
  counts: QueueStateCounts
}

export interface QueueHealth {
  status: 'starting' | 'healthy' | 'degraded' | 'closing' | 'stopped'
  /** Timestamp of the last failed BroccoliDB WAL flush, if one occurred. */
  lastPersistenceFailureAt?: number
}

export interface JobQuery {
  queueName?: string
  state?: JobState | JobState[]
  limit?: number
  offset?: number
  /** Return records older than this ID from the bounded recent inspection window. */
  beforeId?: string
}

export interface RetryResult {
  retried: boolean
  job: Job | null
}

export interface WorkerHandle {
  readonly id: string
  readonly queueName: string
  readonly isRunning: boolean
  readonly activeCount: number
  readonly concurrency: number
  start(): Promise<this>
  pause(): void
  resume(): void
  stop(options?: { drainTimeoutMs?: number }): Promise<void>
}

export interface DashboardOptions {
  host?: string
  port?: number
  /** Required when binding outside loopback. Use a randomly generated token of at least 32 characters. */
  authToken?: string
  /** Exact browser origins permitted to access this server, including scheme and port. */
  allowedOrigins?: readonly string[]
  /** TLS credentials for direct remote access. Prefer a TLS reverse proxy for certificate rotation. */
  tls?: { cert: string | Buffer; key: string | Buffer }
}

export interface DashboardHandle {
  readonly server: Server | import('node:https').Server
  readonly address: string
  close(): Promise<void>
}

export interface BroccoliDatabase {
  /** BroccoliDB workspace path, used to prevent duplicate queue owners in this process. */
  readonly workspaceRoot?: string
  start(): Promise<void>
  flush(): Promise<void>
  getTable<T extends Record<string, unknown> = Record<string, unknown>>(name: string): BroccoliTable<T>
}

export interface BroccoliTable<T extends Record<string, unknown>> {
  get(id: string): T | undefined
  getAll(): readonly T[]
  put(id: string, record: T): T
  putMany(entries: ReadonlyArray<{ id: string; record: T }>): readonly T[]
  delete(id: string): boolean
  query(options?: BroccoliQueryOptions): readonly T[]
  createIndex(field: keyof T & string): void
  createSortedIndex(field: keyof T & string): void
  createCompositeIndex(fields: readonly (keyof T & string)[]): void
}

export interface BroccoliQueryOptions {
  where?: Record<string, unknown>
  limit?: number
  offset?: number
  sortBy?: string | readonly string[]
  sortOrder?: 'asc' | 'desc' | readonly ('asc' | 'desc')[]
}

export interface QueueEvents {
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'job', listener: (job: Job) => void): this
}
