import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { realpath } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import type {
  AddJob,
  BackoffOptions,
  BroccoliDatabase,
  BroccoliTable,
  DashboardOptions,
  Job,
  JobError,
  JobOptions,
  JobQuery,
  JobState,
  JsonValue,
  QueueOptions,
  QueueHealth,
  QueueStateCounts,
  QueueSummary,
  RetryResult,
  WorkerContext,
  WorkerHandle,
  WorkerOptions
} from './types.js'

const STATES: readonly JobState[] = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled']
const TERMINAL_STATES: readonly JobState[] = ['completed', 'failed', 'cancelled']
const SCHEMA_VERSION = 1
const DEFAULT_BACKOFF: BackoffOptions = { type: 'exponential', delayMs: 1_000, maxDelayMs: 60_000 }
const MAX_PAGE_SIZE = 500
const MAX_PRUNE_BATCH_SIZE = 5_000
const MAX_ERROR_MESSAGE_LENGTH = 8_192
const MAX_ERROR_STACK_LENGTH = 32_768
const ACTIVE_QUEUE_WORKSPACES = new Map<string, BroccoliQueue>()
const ACTIVE_QUEUE_DATABASES = new WeakMap<BroccoliDatabase, Map<string, BroccoliQueue>>()

interface StoredJob extends Record<string, unknown>, Job<JsonValue, JsonValue> {
  lockToken?: string
  sequence: number
}

interface QueueRecord extends Record<string, unknown> {
  name: string
  paused: boolean
  createdAt: number
  updatedAt: number
  defaultJobOptions?: JobOptions
}

interface MetadataRecord extends Record<string, unknown> {
  version: number
  createdAt: number
}

interface ClaimedJob {
  job: StoredJob
  token: string
}

interface ReadyEntry {
  id: string
  priority: number
  sequence: number
}

interface DelayedEntry extends ReadyEntry {
  availableAt: number
}

interface TerminalEntry {
  id: string
  finishedAt: number
}

interface LeaseEntry {
  id: string
  token: string
  expiresAt: number
}

interface FlushWaiter {
  resolve: () => void
  reject: (error: unknown) => void
}

class MinHeap<T> {
  #values: T[] = []
  #compare: (a: T, b: T) => number

  constructor (compare: (a: T, b: T) => number) {
    this.#compare = compare
  }

  get size (): number { return this.#values.length }
  peek (): T | undefined { return this.#values[0] }

  push (value: T): void {
    this.#values.push(value)
    let index = this.#values.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.#compare(this.#values[index]!, this.#values[parent]!) >= 0) break
      ;[this.#values[index], this.#values[parent]] = [this.#values[parent]!, this.#values[index]!]
      index = parent
    }
  }

  pop (): T | undefined {
    if (!this.#values.length) return undefined
    const first = this.#values[0]
    const last = this.#values.pop()!
    if (this.#values.length) {
      this.#values[0] = last
      let index = 0
      while (true) {
        const left = index * 2 + 1
        const right = left + 1
        let smallest = index
        if (left < this.#values.length && this.#compare(this.#values[left]!, this.#values[smallest]!) < 0) smallest = left
        if (right < this.#values.length && this.#compare(this.#values[right]!, this.#values[smallest]!) < 0) smallest = right
        if (smallest === index) break
        ;[this.#values[index], this.#values[smallest]] = [this.#values[smallest]!, this.#values[index]!]
        index = smallest
      }
    }
    return first
  }
}

function readyHeap (): MinHeap<ReadyEntry> {
  return new MinHeap((a, b) => b.priority - a.priority || a.sequence - b.sequence)
}

function delayedHeap (): MinHeap<DelayedEntry> {
  return new MinHeap((a, b) => a.availableAt - b.availableAt || b.priority - a.priority || a.sequence - b.sequence)
}

function leaseHeap (): MinHeap<LeaseEntry> {
  return new MinHeap((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id))
}

interface NormalizedOptions {
  priority: number
  delayMs: number
  attempts: number
  backoff: BackoffOptions
  idempotencyKey?: string
}

export type JobProcessor<T = JsonValue, R = JsonValue> = (job: Job<T>, context: WorkerContext) => R | Promise<R>

function validQueueName (name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 128 && /^[\w./:-]+$/.test(name)
}

function assertQueueName (name: string): void {
  assert(validQueueName(name), 'queue name must be 1-128 characters and contain only letters, numbers, _, ., /, :, or -')
}

function jsonCloneWithSize<T> (value: T, label: string, maxBytes = Number.MAX_SAFE_INTEGER): { value: T; bytes: number } {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new TypeError(`${label} must be JSON serializable`, { cause: error })
  }
  assert(serialized !== undefined, `${label} must be JSON serializable`)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  assert(bytes <= maxBytes, `${label} exceeds the configured ${maxBytes}-byte limit`)
  return { value: JSON.parse(serialized) as T, bytes }
}

function jsonClone<T> (value: T, label: string): T {
  return jsonCloneWithSize(value, label).value
}

function safeInteger (value: number, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  assert(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${label} must be an integer between ${minimum} and ${maximum}`)
}

function compareJobs (a: StoredJob, b: StoredJob): number {
  return b.priority - a.priority || a.sequence - b.sequence
}

function emptyCounts (): QueueStateCounts {
  return { waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0, cancelled: 0 }
}

function backoffDelay (backoff: BackoffOptions, attemptsMade: number): number {
  const multiplier = backoff.type === 'exponential' ? 2 ** Math.max(0, attemptsMade - 1) : 1
  return Math.min(backoff.maxDelayMs ?? 60_000, backoff.delayMs * multiplier)
}

function serializeError (error: unknown): JobError {
  if (error instanceof Error) {
    try {
      const code = 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number')
        ? error.code
        : undefined
      return {
        name: (typeof error.name === 'string' && error.name ? error.name : 'Error').slice(0, 256),
        message: (typeof error.message === 'string' && error.message ? error.message : 'Job handler failed').slice(0, MAX_ERROR_MESSAGE_LENGTH),
        ...(typeof error.stack === 'string' && error.stack ? { stack: error.stack.slice(0, MAX_ERROR_STACK_LENGTH) } : {}),
        ...(code !== undefined ? { code: typeof code === 'string' ? code.slice(0, 256) : code } : {})
      }
    } catch {
      return { name: 'Error', message: 'Job handler failed with an unreadable error object' }
    }
  }
  let message: string
  try { message = String(error) } catch { message = 'Job handler threw a value that could not be converted to text' }
  return { name: 'Error', message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH) }
}

function publicJob<T = JsonValue, R = JsonValue> (job: StoredJob): Job<T, R> {
  const { lockToken: _lockToken, sequence: _sequence, ...visible } = job
  return jsonClone(visible, 'job record') as unknown as Job<T, R>
}

/**
 * A BroccoliDB-backed queue. The database kernel is supplied by the host and
 * remains host-owned; queue.close() drains workers and flushes it but does not
 * stop the kernel.
 */
export class BroccoliQueue extends EventEmitter {
  readonly namespace: string
  readonly db: BroccoliDatabase
  readonly defaultJobOptions: JobOptions

  #jobs!: BroccoliTable<StoredJob>
  #queues!: BroccoliTable<QueueRecord>
  #metadata!: BroccoliTable<MetadataRecord>
  #workers = new Set<QueueWorker>()
  #controllers = new Map<string, Set<AbortController>>()
  #counts = new Map<string, QueueStateCounts>()
  #ready = new Map<string, MinHeap<ReadyEntry>>()
  #delayed = new Map<string, MinHeap<DelayedEntry>>()
  #leases = new Map<string, MinHeap<LeaseEntry>>()
  #terminal = new MinHeap<TerminalEntry>((a, b) => a.finishedAt - b.finishedAt)
  #recentIds: string[] = []
  #sequence = 0
  #terminalCount = 0
  #started = false
  #maintenanceTimer: NodeJS.Timeout | undefined
  #flushTimer: NodeJS.Timeout | undefined
  #flushRunning = false
  #flushWaiters: FlushWaiter[] = []
  #flushBatchDelayMs: number
  #retentionMs: number
  #startedAt = 0
  #startPromise: Promise<this> | undefined
  #closePromise: Promise<void> | undefined
  #closing = false
  #namespaceRegistryKey: string | undefined
  #usesDatabaseRegistry = false
  #lastPersistenceFailureAt: number | undefined
  #maintenancePromise: Promise<void> | undefined
  #maxJobDataBytes: number
  #maxJobResultBytes: number
  #maxBulkItems: number
  #maxBulkBytes: number
  #maintenanceIntervalMs: number
  #maintenanceBatchSize: number
  #maintenanceMaxBatches: number
  #dashboards = new Set<import('./types.js').DashboardHandle>()
  #dashboardStarts = new Set<Promise<import('./types.js').DashboardHandle>>()

  constructor (options: QueueOptions) {
    super()
    assert(options && typeof options === 'object' && options.db, 'BroccoliQueue requires a started BroccoliDatabaseKernel')
    this.db = options.db
    this.namespace = options.namespace ?? 'broccoli_queue'
    assert(/^[a-zA-Z0-9_-]{1,48}$/.test(this.namespace), 'namespace must contain 1-48 letters, numbers, underscores, or hyphens')
    this.defaultJobOptions = jsonClone(options.defaultJobOptions ?? {}, 'defaultJobOptions')
    assert(this.defaultJobOptions && typeof this.defaultJobOptions === 'object' && !Array.isArray(this.defaultJobOptions),
      'defaultJobOptions must be an object')
    this.#retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1_000
    safeInteger(this.#retentionMs, 'retentionMs', 0)
    this.#flushBatchDelayMs = options.flushBatchDelayMs ?? 0
    safeInteger(this.#flushBatchDelayMs, 'flushBatchDelayMs', 0, 1_000)
    this.#maxJobDataBytes = options.maxJobDataBytes ?? 1_048_576
    this.#maxJobResultBytes = options.maxJobResultBytes ?? 1_048_576
    this.#maxBulkItems = options.maxBulkItems ?? 1_000
    this.#maxBulkBytes = options.maxBulkBytes ?? 16_777_216
    this.#maintenanceIntervalMs = options.maintenanceIntervalMs ?? 5_000
    this.#maintenanceBatchSize = options.maintenanceBatchSize ?? 5_000
    this.#maintenanceMaxBatches = options.maintenanceMaxBatches ?? 5
    safeInteger(this.#maxJobDataBytes, 'maxJobDataBytes', 1, 67_108_864)
    safeInteger(this.#maxJobResultBytes, 'maxJobResultBytes', 1, 67_108_864)
    safeInteger(this.#maxBulkItems, 'maxBulkItems', 1, 10_000)
    safeInteger(this.#maxBulkBytes, 'maxBulkBytes', 1, 67_108_864)
    safeInteger(this.#maintenanceIntervalMs, 'maintenanceIntervalMs', 1_000, 24 * 60 * 60 * 1_000)
    safeInteger(this.#maintenanceBatchSize, 'maintenanceBatchSize', 1, MAX_PRUNE_BATCH_SIZE)
    safeInteger(this.#maintenanceMaxBatches, 'maintenanceMaxBatches', 1, 100)
    this.#normalizeOptions('__defaults__', this.defaultJobOptions)
  }

  get isStarted (): boolean {
    return this.#started
  }

  getHealth (): QueueHealth {
    const status: QueueHealth['status'] = this.#closing
      ? 'closing'
      : this.#lastPersistenceFailureAt !== undefined
        ? 'degraded'
        : !this.#started ? this.#startPromise ? 'starting' : 'stopped' : 'healthy'
    return {
      status,
      ...(this.#lastPersistenceFailureAt !== undefined ? { lastPersistenceFailureAt: this.#lastPersistenceFailureAt } : {})
    }
  }

  async start (): Promise<this> {
    if (this.#closePromise) await this.#closePromise
    if (this.#started) return this
    if (this.#startPromise) return await this.#startPromise

    const operation = this.#startInternal()
    this.#startPromise = operation
    try {
      return await operation
    } finally {
      if (this.#startPromise === operation) this.#startPromise = undefined
    }
  }

  async #startInternal (): Promise<this> {
    try {
      await this.db.start()
      await this.#acquireNamespace()
      this.#jobs = this.db.getTable<StoredJob>(`${this.namespace}_jobs`)
      this.#queues = this.db.getTable<QueueRecord>(`${this.namespace}_queues`)
      this.#metadata = this.db.getTable<MetadataRecord>(`${this.namespace}_meta`)

      this.#jobs.createIndex('state')
      this.#jobs.createCompositeIndex(['queueName', 'state'])

      const metadata = this.#metadata.get('schema')
      if (metadata && metadata.version !== SCHEMA_VERSION) {
        throw new Error(`BroccoliQueue table format ${metadata.version} is not supported by this version (expected ${SCHEMA_VERSION})`)
      }
      if (!metadata) this.#metadata.put('schema', { version: SCHEMA_VERSION, createdAt: Date.now() })

      this.#rebuildCounts()
      await this.#flushWrites()
      this.#started = true
      this.#startedAt = Date.now()
      this.#maintenanceTimer = setInterval(() => { void this.#runMaintenance() }, this.#maintenanceIntervalMs)
      this.#maintenanceTimer.unref?.()
      const startupMaintenance = setImmediate(() => { void this.#runMaintenance() })
      startupMaintenance.unref?.()
      return this
    } catch (error) {
      this.#releaseNamespace()
      throw error
    }
  }

  /** Add one job. A successful return means the job's WAL frames were flushed. */
  async add<T = JsonValue> (name: string, data: T, options: JobOptions = {}): Promise<Job<T>> {
    const [job] = await this.addBulk([{ name, data, options }])
    return job as Job<T>
  }

  /** Add a producer batch and flush its WAL frames once. */
  async addBulk<T = JsonValue> (items: readonly AddJob<T>[]): Promise<Job<T>[]> {
    this.#assertStarted()
    assert(Array.isArray(items), 'addBulk() requires an array of jobs')
    if (items.length === 0) return []
    safeInteger(items.length, 'addBulk item count', 1, this.#maxBulkItems)

    // Validate the whole batch before the first mutation so malformed payloads
    // cannot leave a partially accepted producer batch.
    let totalDataBytes = 0
    const normalized = items.map(item => {
      assert(item && typeof item === 'object', 'each addBulk item must include a queue name and data')
      assertQueueName(item.name)
      const data = jsonCloneWithSize(item.data, 'job data', this.#maxJobDataBytes)
      totalDataBytes += data.bytes
      assert(totalDataBytes <= this.#maxBulkBytes, `addBulk payload exceeds the configured ${this.#maxBulkBytes}-byte limit`)
      return {
        name: item.name,
        data: data.value as JsonValue,
        options: this.#normalizeOptions(item.name, item.options ?? {})
      }
    })

    const result: Job<T>[] = []
    const created: Job<T>[] = []
    const touched = new Set<string>()
    const now = Date.now()

    for (const item of normalized) {
      this.#ensureQueue(item.name)
      const id = item.options.idempotencyKey === undefined
        ? randomUUID()
        : this.#idForKey(item.name, item.options.idempotencyKey)
      const duplicate = this.#jobs.get(id)
      if (duplicate) {
        result.push(publicJob<T>(duplicate))
        continue
      }

      const availableAt = now + item.options.delayMs
      const job: StoredJob = {
        id,
        queueName: item.name,
        data: item.data,
        state: item.options.delayMs > 0 ? 'delayed' : 'waiting',
        priority: item.options.priority,
        createdAt: now,
        updatedAt: now,
        availableAt,
        attemptsMade: 0,
        maxAttempts: item.options.attempts,
        backoff: item.options.backoff,
        sequence: ++this.#sequence,
        ...(item.options.idempotencyKey !== undefined ? { idempotencyKey: item.options.idempotencyKey } : {})
      }
      this.#writeJob(job)
      touched.add(item.name)
      const visible = publicJob<T>(job)
      result.push(visible)
      created.push(visible)
    }

    await this.#flushWrites()
    for (const name of touched) this.#wakeWorkers(name)
    for (const job of created) this.#emitSafely('job', job)
    return result
  }

  /** Create a queue or return its existing configuration. */
  async createQueue (name: string, options: { paused?: boolean; defaultJobOptions?: JobOptions } = {}): Promise<QueueSummary> {
    this.#assertStarted()
    assert(options && typeof options === 'object' && !Array.isArray(options), 'queue options must be an object')
    assertQueueName(name)
    const record = this.#ensureQueue(name, options)
    // Even an idempotent create waits behind a concurrent create's WAL flush.
    await this.#flushWrites()
    return this.#summary(record)
  }

  /** Register a worker; call handle.start() to begin claiming jobs. */
  process<T = JsonValue, R = JsonValue> (
    name: string,
    processor: JobProcessor<T, R>,
    options: WorkerOptions = {}
  ): WorkerHandle {
    this.#assertStarted()
    assertQueueName(name)
    assert(typeof processor === 'function', 'process() requires a job handler')
    assert(options && typeof options === 'object' && !Array.isArray(options), 'worker options must be an object')
    const worker = new QueueWorker(this, name, processor as unknown as JobProcessor, options)
    this.registerWorker(worker)
    return worker
  }

  getJob<T = JsonValue, R = JsonValue> (id: string): Job<T, R> | null {
    this.#assertStarted()
    const job = this.#jobs.get(id)
    return job ? publicJob<T, R>(job) : null
  }

  getJobs<T = JsonValue> (query: JobQuery = {}): Job<T>[] {
    this.#assertStarted()
    if (query.queueName !== undefined) assertQueueName(query.queueName)
    const limit = query.limit ?? 50
    const offset = query.offset ?? 0
    safeInteger(limit, 'limit', 1, MAX_PAGE_SIZE)
    safeInteger(offset, 'offset', 0)
    if (query.beforeId !== undefined) assert(typeof query.beforeId === 'string' && query.beforeId.length > 0, 'beforeId must be a non-empty job ID')

    const states = query.state === undefined ? undefined : Array.isArray(query.state) ? query.state : [query.state]
    for (const state of states ?? []) assert(STATES.includes(state), `unknown job state: ${state}`)
    const result: Job<T>[] = []
    let matched = 0
    const cursorIndex = query.beforeId === undefined ? this.#recentIds.length : this.#recentIds.lastIndexOf(query.beforeId)
    if (query.beforeId !== undefined && cursorIndex < 0) return result
    for (let index = cursorIndex - 1; index >= 0 && result.length < limit; index--) {
      const job = this.#jobs.get(this.#recentIds[index]!)
      if (!job) continue
      if (query.queueName !== undefined && job.queueName !== query.queueName) continue
      if (states?.length && !states.includes(job.state)) continue
      if (matched++ < offset) continue
      result.push(publicJob<T>(job))
    }
    return result
  }

  getQueues (): QueueSummary[] {
    this.#assertStarted()
    return this.#queues.getAll().map(queue => this.#summary(queue)).sort((a, b) => a.name.localeCompare(b.name))
  }

  getWorkers (): Array<{ id: string; queueName: string; activeCount: number; concurrency: number; isRunning: boolean }> {
    return [...this.#workers].map(worker => ({
      id: worker.id,
      queueName: worker.queueName,
      activeCount: worker.activeCount,
      concurrency: worker.concurrency,
      isRunning: worker.isRunning
    }))
  }

  getOverview () {
    this.#assertStarted()
    const queues = this.getQueues()
    const totals = emptyCounts()
    for (const queue of queues) {
      for (const state of STATES) totals[state] += queue.counts[state]
    }
    return {
      startedAt: this.#startedAt,
      health: this.getHealth(),
      queues,
      workers: this.getWorkers(),
      totals
    }
  }

  getQueue (name: string): QueueSummary | null {
    this.#assertStarted()
    assertQueueName(name)
    const queue = this.#queues.get(name)
    return queue ? this.#summary(queue) : null
  }

  async pause (name: string): Promise<boolean> {
    return await this.#setPaused(name, true)
  }

  async resume (name: string): Promise<boolean> {
    const changed = await this.#setPaused(name, false)
    if (changed) this.#wakeWorkers(name)
    return changed
  }

  async retry (id: string, options: { delayMs?: number } = {}): Promise<RetryResult> {
    this.#assertStarted()
    const delayMs = options.delayMs ?? 0
    safeInteger(delayMs, 'delayMs', 0, Number.MAX_SAFE_INTEGER - Date.now())
    const current = this.#jobs.get(id)
    if (!current || current.state !== 'failed') return { retried: false, job: current ? publicJob(current) : null }

    const now = Date.now()
    const next: StoredJob = {
      ...current,
      state: delayMs ? 'delayed' : 'waiting',
      attemptsMade: 0,
      availableAt: now + delayMs,
      updatedAt: now,
      ...(current.processedAt !== undefined ? { processedAt: undefined } : {}),
      ...(current.finishedAt !== undefined ? { finishedAt: undefined } : {}),
      ...(current.lastError !== undefined ? { lastError: undefined } : {}),
      ...(current.returnValue !== undefined ? { returnValue: undefined } : {}),
      workerId: undefined,
      leaseExpiresAt: undefined,
      lockToken: undefined
    }
    this.#writeJob(next, current)
    await this.#flushWrites()
    this.#wakeWorkers(current.queueName)
    return { retried: true, job: publicJob(next) }
  }

  async cancel (id: string): Promise<boolean> {
    this.#assertStarted()
    const current = this.#jobs.get(id)
    if (!current || !['waiting', 'delayed', 'active'].includes(current.state)) return false
    const now = Date.now()
    const next: StoredJob = {
      ...current,
      state: 'cancelled',
      updatedAt: now,
      finishedAt: now,
      workerId: undefined,
      leaseExpiresAt: undefined,
      lockToken: undefined
    }
    this.#writeJob(next, current)
    for (const controller of this.#controllers.get(id) ?? []) controller.abort(new Error('Job was cancelled'))
    await this.#flushWrites()
    return true
  }

  async delete (id: string): Promise<boolean> {
    this.#assertStarted()
    const job = this.#jobs.get(id)
    if (!job || job.state === 'active') return false
    const deleted = this.#jobs.delete(id)
    if (deleted) {
      this.#adjustCount(job.queueName, job.state, -1)
      if (TERMINAL_STATES.includes(job.state)) this.#terminalCount--
      this.#recentIds = this.#recentIds.filter(recentId => recentId !== job.id)
      if (job.state === 'waiting' || job.state === 'delayed') this.#compactQueueIndex(job.queueName)
      if (TERMINAL_STATES.includes(job.state)) this.#compactTerminalIndex()
      await this.#flushWrites()
    }
    return deleted
  }

  /** Remove terminal records older than the queue retention window in bounded batches. */
  async prune (options: { retentionMs?: number; batchSize?: number } = {}): Promise<number> {
    this.#assertStarted()
    const retentionMs = options.retentionMs ?? this.#retentionMs
    const batchSize = options.batchSize ?? 250
    safeInteger(retentionMs, 'retentionMs', 0)
    safeInteger(batchSize, 'batchSize', 1, MAX_PRUNE_BATCH_SIZE)
    const cutoff = Date.now() - retentionMs
    let removed = 0
    let inspected = 0
    const maxInspected = batchSize * 4
    while (removed < batchSize && inspected < maxInspected && (this.#terminal.peek()?.finishedAt ?? Infinity) <= cutoff) {
      inspected++
      const entry = this.#terminal.pop()!
      const job = this.#jobs.get(entry.id)
      if (!job || !TERMINAL_STATES.includes(job.state) || job.finishedAt !== entry.finishedAt || job.finishedAt > cutoff) continue
      if (this.#jobs.delete(job.id)) {
        this.#adjustCount(job.queueName, job.state, -1)
        this.#terminalCount--
        removed++
      }
    }
    if (removed) await this.#flushWrites()
    return removed
  }

  /** Start an authenticated, same-process monitoring and job-management dashboard. */
  async startDashboard (options: DashboardOptions = {}) {
    this.#assertStarted()
    const { createDashboardServer } = await import('./dashboard.js')
    this.#assertStarted()
    const startup = createDashboardServer(this, options)
    this.#dashboardStarts.add(startup)
    try {
      const handle = await startup
      if (this.#closing || !this.#started) {
        await handle.close()
        throw new Error('BroccoliQueue is closing')
      }
      this.#dashboards.add(handle)
      handle.server.once('close', () => this.#dashboards.delete(handle))
      return handle
    } finally {
      this.#dashboardStarts.delete(startup)
    }
  }

  async close (options: { drainTimeoutMs?: number } = {}): Promise<void> {
    const drainTimeoutMs = options.drainTimeoutMs ?? 30_000
    safeInteger(drainTimeoutMs, 'drainTimeoutMs', 0)
    if (this.#closePromise) return await this.#closePromise
    const operation = this.#closeInternal({ drainTimeoutMs })
    this.#closePromise = operation
    try {
      await operation
    } finally {
      if (this.#closePromise === operation) this.#closePromise = undefined
    }
  }

  async #closeInternal (options: { drainTimeoutMs: number }): Promise<void> {
    if (this.#startPromise) await this.#startPromise
    if (!this.#started) return
    this.#closing = true
    if (this.#maintenanceTimer) clearInterval(this.#maintenanceTimer)
    this.#maintenanceTimer = undefined
    try {
      await this.#maintenancePromise?.catch(error => this.#reportError(error))
      await Promise.allSettled([...this.#dashboardStarts])
      const dashboardResults = await Promise.allSettled([...this.#dashboards].map(dashboard => dashboard.close()))
      for (const result of dashboardResults) if (result.status === 'rejected') this.#reportError(result.reason)
      const workerResults = await Promise.allSettled([...this.#workers].map(worker => worker.stop(options)))
      for (const result of workerResults) if (result.status === 'rejected') this.#reportError(result.reason)
      this.#workers.clear()
      await this.#flushWrites()
      this.#started = false
      this.#releaseNamespace()
    } finally {
      this.#closing = false
      if (this.#started && !this.#maintenanceTimer) this.#scheduleMaintenance()
    }
  }

  /** Internal worker boundary: persist a claim batch before starting handlers. */
  async flushWrites (): Promise<void> {
    await this.#flushWrites()
  }

  // Worker coordination methods are public for the worker implementation and intentionally not
  // part of the documented application API.
  getWorkerOptions (name: string): JobOptions {
    const queue = this.#queues.get(name)
    return { ...this.defaultJobOptions, ...(queue?.defaultJobOptions ?? {}) }
  }

  async ensureQueue (name: string): Promise<void> {
    this.#assertStarted()
    if (!this.#queues.get(name)) this.#ensureQueue(name)
    // A previous creator may have installed the record in memory but still be
    // waiting for its WAL flush. Worker startup must wait behind that barrier.
    await this.#flushWrites()
  }

  isPaused (name: string): boolean {
    return this.#queues.get(name)?.paused ?? false
  }

  claimReady (name: string, workerId: string, limit: number, leaseDurationMs: number): ClaimedJob[] {
    this.#assertStarted()
    safeInteger(limit, 'claim limit', 0, MAX_PAGE_SIZE)
    safeInteger(leaseDurationMs, 'leaseDurationMs', 1, 24 * 60 * 60 * 1_000)
    if (limit <= 0) return []
    const now = Date.now()
    this.#promoteDue(name, now)
    if (this.isPaused(name)) return []
    const ready = this.#readyHeap(name)

    const claimed: ClaimedJob[] = []
    while (claimed.length < limit && ready.size) {
      const entry = ready.pop()!
      const current = this.#jobs.get(entry.id)
      // This synchronous read/modify/write contains no await. Within BroccoliDB's single Node.js
      // isolate, concurrent worker pumps cannot interleave between observing and claiming a row.
      const latest = current
      if (!latest || latest.sequence !== entry.sequence || !['waiting', 'delayed'].includes(latest.state) || latest.availableAt > now) continue
      const token = randomUUID()
      const next: StoredJob = {
        ...latest,
        state: 'active',
        attemptsMade: latest.attemptsMade + 1,
        processedAt: latest.processedAt ?? now,
        updatedAt: now,
        workerId,
        leaseExpiresAt: now + leaseDurationMs,
        lockToken: token
      }
      this.#writeJob(next, latest)
      claimed.push({ job: next, token })
    }
    return claimed
  }

  async promoteDue (name: string): Promise<number> {
    this.#assertStarted()
    assertQueueName(name)
    const promoted = this.#promoteDue(name, Date.now())
    if (promoted) await this.#flushWrites()
    return promoted
  }

  async recoverExpired (name: string, limit: number): Promise<number> {
    this.#assertStarted()
    assertQueueName(name)
    safeInteger(limit, 'limit', 0, MAX_PAGE_SIZE)
    if (limit === 0) return 0

    const now = Date.now()
    const leases = this.#leaseHeap(name)
    let recovered = 0
    let inspected = 0
    const maxInspected = Math.max(64, limit * 8)
    while (recovered < limit && inspected < maxInspected && (leases.peek()?.expiresAt ?? Infinity) <= now) {
      inspected++
      const entry = leases.pop()!
      const latest = this.#jobs.get(entry.id)
      if (!latest || latest.state !== 'active' || latest.lockToken !== entry.token || latest.leaseExpiresAt !== entry.expiresAt) continue
      const exhausted = latest.attemptsMade >= latest.maxAttempts
      const nextAvailableAt = exhausted ? now : now + backoffDelay(latest.backoff, latest.attemptsMade)
      const next: StoredJob = {
        ...latest,
        state: exhausted ? 'failed' : 'delayed',
        updatedAt: now,
        availableAt: nextAvailableAt,
        ...(exhausted ? { finishedAt: now, lastError: { name: 'LeaseExpiredError', message: 'Worker lease expired before the job was acknowledged' } } : {}),
        workerId: undefined,
        leaseExpiresAt: undefined,
        lockToken: undefined
      }
      this.#writeJob(next, latest)
      for (const controller of this.#controllers.get(latest.id) ?? []) {
        controller.abort(new Error('Job lease expired before acknowledgment'))
      }
      recovered++
    }
    if (recovered) await this.#flushWrites()
    return recovered
  }

  async renewLease (id: string, token: string, leaseDurationMs: number): Promise<boolean> {
    safeInteger(leaseDurationMs, 'leaseDurationMs', 1, 24 * 60 * 60 * 1_000)
    const current = this.#jobs.get(id)
    const now = Date.now()
    if (!current || current.state !== 'active' || current.lockToken !== token || (current.leaseExpiresAt ?? 0) <= now) return false
    this.#writeJob({ ...current, updatedAt: now, leaseExpiresAt: now + leaseDurationMs }, current)
    await this.#flushWrites()
    return true
  }

  async completeClaim (id: string, token: string, result: unknown): Promise<boolean> {
    const current = this.#jobs.get(id)
    const now = Date.now()
    if (!current || current.state !== 'active' || current.lockToken !== token || (current.leaseExpiresAt ?? 0) <= now) return false
    let returnValue: JsonValue | undefined
    try {
      returnValue = result === undefined
        ? undefined
        : jsonCloneWithSize(result, 'job result', this.#maxJobResultBytes).value as JsonValue
    } catch (error) {
      return await this.failClaim(id, token, error)
    }
    const next: StoredJob = {
      ...current,
      state: 'completed',
      updatedAt: now,
      finishedAt: now,
      ...(returnValue !== undefined ? { returnValue } : {}),
      lastError: undefined,
      workerId: undefined,
      leaseExpiresAt: undefined,
      lockToken: undefined
    }
    this.#writeJob(next, current)
    await this.#flushWrites()
    this.#emitSafely('completed', publicJob(next))
    return true
  }

  async failClaim (id: string, token: string, error: unknown): Promise<boolean> {
    const jobError = serializeError(error)
    const current = this.#jobs.get(id)
    const now = Date.now()
    if (!current || current.state !== 'active' || current.lockToken !== token || (current.leaseExpiresAt ?? 0) <= now) return false
    const exhausted = current.attemptsMade >= current.maxAttempts
    const next: StoredJob = {
      ...current,
      state: exhausted ? 'failed' : 'delayed',
      availableAt: exhausted ? current.availableAt : now + backoffDelay(current.backoff, current.attemptsMade),
      updatedAt: now,
      ...(exhausted ? { finishedAt: now } : {}),
      lastError: jobError,
      workerId: undefined,
      leaseExpiresAt: undefined,
      lockToken: undefined
    }
    this.#writeJob(next, current)
    await this.#flushWrites()
    this.#emitSafely(exhausted ? 'failed' : 'retrying', publicJob(next))
    return true
  }

  async releaseClaim (id: string, token: string): Promise<void> {
    await this.releaseClaims([{ id, token }])
  }

  async releaseClaims (
    claims: readonly { id: string; token: string }[],
    options: { restoreAttempts?: boolean } = {}
  ): Promise<void> {
    let released = false
    for (const { id, token } of claims) {
      const current = this.#jobs.get(id)
      if (!current || current.state !== 'active' || current.lockToken !== token) continue
      const now = Date.now()
      this.#writeJob({
        ...current,
        state: current.availableAt > now ? 'delayed' : 'waiting',
        ...(options.restoreAttempts ? { attemptsMade: Math.max(0, current.attemptsMade - 1) } : {}),
        updatedAt: now,
        workerId: undefined,
        leaseExpiresAt: undefined,
        lockToken: undefined
      }, current)
      released = true
    }
    if (released) await this.#flushWrites()
  }

  registerController (id: string, controller: AbortController): void {
    const controllers = this.#controllers.get(id) ?? new Set<AbortController>()
    controllers.add(controller)
    this.#controllers.set(id, controllers)
  }

  unregisterController (id: string, controller: AbortController): void {
    const controllers = this.#controllers.get(id)
    controllers?.delete(controller)
    if (controllers?.size === 0) this.#controllers.delete(id)
  }

  registerWorker (worker: QueueWorker): void {
    // Worker.start() may be waiting for ensureQueue()'s WAL barrier while the
    // queue begins closing. Recheck at registration so that a late continuation
    // cannot restart work after close() has drained the worker set.
    this.#assertStarted()
    this.#workers.add(worker)
  }

  unregisterWorker (worker: QueueWorker): void {
    this.#workers.delete(worker)
  }

  reportWorkerError (error: unknown): void {
    this.#reportError(error)
  }

  async #setPaused (name: string, paused: boolean): Promise<boolean> {
    this.#assertStarted()
    assertQueueName(name)
    const record = this.#ensureQueue(name)
    if (record.paused === paused) {
      await this.#flushWrites()
      return false
    }
    const next = { ...record, paused, updatedAt: Date.now() }
    this.#queues.put(name, next)
    await this.#flushWrites()
    return true
  }

  #ensureQueue (name: string, options: { paused?: boolean; defaultJobOptions?: JobOptions } = {}): QueueRecord {
    assert(options && typeof options === 'object' && !Array.isArray(options), 'queue options must be an object')
    const existing = this.#queues.get(name)
    if (existing) return existing
    if (options.paused !== undefined) assert(typeof options.paused === 'boolean', 'paused must be a boolean')
    if (options.defaultJobOptions !== undefined) {
      assert(options.defaultJobOptions && typeof options.defaultJobOptions === 'object' && !Array.isArray(options.defaultJobOptions),
        'defaultJobOptions must be an object')
      this.#normalizeOptions(name, options.defaultJobOptions)
    }
    const now = Date.now()
    const record: QueueRecord = {
      name,
      paused: options.paused ?? false,
      createdAt: now,
      updatedAt: now,
      ...(options.defaultJobOptions ? { defaultJobOptions: jsonClone(options.defaultJobOptions, 'defaultJobOptions') } : {})
    }
    this.#queues.put(name, record)
    this.#counts.set(name, emptyCounts())
    return record
  }

  #normalizeOptions (name: string, options: JobOptions): NormalizedOptions {
    assert(options && typeof options === 'object' && !Array.isArray(options), 'job options must be an object')
    const queueDefaults = this.#queues?.get(name)?.defaultJobOptions ?? {}
    const values = { ...this.defaultJobOptions, ...queueDefaults, ...options }
    const priority = values.priority ?? 0
    const delayMs = values.delayMs ?? 0
    const attempts = values.attempts ?? 1
    safeInteger(priority, 'priority', -2_147_483_648, 2_147_483_647)
    const maximumDateDelay = Number.MAX_SAFE_INTEGER - Date.now()
    safeInteger(delayMs, 'delayMs', 0, maximumDateDelay)
    safeInteger(attempts, 'attempts', 1, 1_000)

    const rawBackoff = values.backoff ?? DEFAULT_BACKOFF
    assert(rawBackoff.type === 'fixed' || rawBackoff.type === 'exponential', 'backoff.type must be fixed or exponential')
    safeInteger(rawBackoff.delayMs, 'backoff.delayMs', 0, maximumDateDelay)
    if (rawBackoff.maxDelayMs !== undefined) safeInteger(rawBackoff.maxDelayMs, 'backoff.maxDelayMs', 0, maximumDateDelay)

    if (values.idempotencyKey !== undefined) {
      assert(typeof values.idempotencyKey === 'string' && values.idempotencyKey.length > 0 && values.idempotencyKey.length <= 256,
        'idempotencyKey must be a non-empty string no longer than 256 characters')
    }
    return {
      priority,
      delayMs,
      attempts,
      backoff: jsonClone(rawBackoff, 'backoff'),
      ...(values.idempotencyKey !== undefined ? { idempotencyKey: values.idempotencyKey } : {})
    }
  }

  #idForKey (queueName: string, key: string): string {
    const hash = createHash('sha256').update(`${this.namespace}\0${queueName}\0${key}`).digest('hex')
    return `idem_${hash}`
  }

  #writeJob (next: StoredJob, previous?: StoredJob): void {
    this.#jobs.put(next.id, next)
    if (!previous) {
      this.#adjustCount(next.queueName, next.state, 1)
      if (TERMINAL_STATES.includes(next.state)) this.#terminalCount++
      this.#recentIds.push(next.id)
      if (this.#recentIds.length > 12_000) this.#recentIds.splice(0, 2_000)
    }
    else if (previous.state !== next.state) {
      this.#adjustCount(previous.queueName, previous.state, -1)
      this.#adjustCount(next.queueName, next.state, 1)
      if (TERMINAL_STATES.includes(previous.state)) this.#terminalCount--
      if (TERMINAL_STATES.includes(next.state)) this.#terminalCount++
    }
    if (next.state === 'waiting' || next.state === 'delayed') this.#pushPending(next)
    if (next.state === 'active' && next.lockToken && next.leaseExpiresAt !== undefined &&
      (!previous || previous.state !== 'active' || previous.lockToken !== next.lockToken || previous.leaseExpiresAt !== next.leaseExpiresAt)) {
      this.#leaseHeap(next.queueName).push({ id: next.id, token: next.lockToken, expiresAt: next.leaseExpiresAt })
    }
    if (TERMINAL_STATES.includes(next.state) && next.finishedAt !== undefined && previous?.state !== next.state) this.#pushTerminal(next)
    if (previous && ['waiting', 'delayed'].includes(previous.state) && !['waiting', 'delayed'].includes(next.state)) this.#compactQueueIndex(previous.queueName)
    if (previous && TERMINAL_STATES.includes(previous.state) && !TERMINAL_STATES.includes(next.state)) this.#compactTerminalIndex()
    if (previous?.state === 'active' && (next.state !== 'active' || previous.lockToken !== next.lockToken || previous.leaseExpiresAt !== next.leaseExpiresAt)) {
      this.#compactLeaseIndex(previous.queueName)
    }
  }

  #adjustCount (queueName: string, state: JobState, amount: number): void {
    const counts = this.#counts.get(queueName) ?? emptyCounts()
    counts[state] = Math.max(0, counts[state] + amount)
    this.#counts.set(queueName, counts)
  }

  #rebuildCounts (): void {
    this.#counts.clear()
    for (const queue of this.#queues.getAll()) this.#counts.set(queue.name, emptyCounts())
    const jobs = this.#jobs.getAll()
    this.#recentIds = []
    this.#sequence = 0
    this.#terminalCount = 0
    this.#ready.clear()
    this.#delayed.clear()
    this.#leases.clear()
    this.#terminal = new MinHeap((a, b) => a.finishedAt - b.finishedAt)
    for (const job of jobs) {
      this.#adjustCount(job.queueName, job.state, 1)
      if (TERMINAL_STATES.includes(job.state)) this.#terminalCount++
      this.#sequence = Math.max(this.#sequence, job.sequence ?? 0)
      if (job.state === 'waiting' || job.state === 'delayed') this.#pushPending(job)
      if (job.state === 'active' && job.lockToken && job.leaseExpiresAt !== undefined) {
        this.#leaseHeap(job.queueName).push({ id: job.id, token: job.lockToken, expiresAt: job.leaseExpiresAt })
      }
      if (TERMINAL_STATES.includes(job.state)) this.#pushTerminal(job)
    }
    const compareSequence = (a: StoredJob, b: StoredJob) => (a.sequence ?? a.createdAt) - (b.sequence ?? b.createdAt)
    const recent = new MinHeap<StoredJob>(compareSequence)
    for (const job of jobs) {
      if (recent.size < 12_000) recent.push(job)
      else if (compareSequence(job, recent.peek()!) > 0) {
        recent.pop()
        recent.push(job)
      }
    }
    while (recent.size) this.#recentIds.push(recent.pop()!.id)
  }

  #summary (record: QueueRecord): QueueSummary {
    return {
      name: record.name,
      paused: record.paused,
      createdAt: record.createdAt,
      counts: { ...(this.#counts.get(record.name) ?? emptyCounts()) }
    }
  }

  #wakeWorkers (name: string): void {
    for (const worker of this.#workers) {
      if (worker.queueName === name) worker.wake()
    }
  }

  #readyHeap (name: string): MinHeap<ReadyEntry> {
    let heap = this.#ready.get(name)
    if (!heap) { heap = readyHeap(); this.#ready.set(name, heap) }
    return heap
  }

  #delayedHeap (name: string): MinHeap<DelayedEntry> {
    let heap = this.#delayed.get(name)
    if (!heap) { heap = delayedHeap(); this.#delayed.set(name, heap) }
    return heap
  }

  #leaseHeap (name: string): MinHeap<LeaseEntry> {
    let heap = this.#leases.get(name)
    if (!heap) { heap = leaseHeap(); this.#leases.set(name, heap) }
    return heap
  }

  #pushPending (job: StoredJob): void {
    const entry = { id: job.id, priority: job.priority, sequence: job.sequence }
    if (job.state === 'waiting') this.#readyHeap(job.queueName).push(entry)
    else if (job.state === 'delayed') this.#delayedHeap(job.queueName).push({ ...entry, availableAt: job.availableAt })
  }

  #promoteDue (name: string, now: number): number {
    const delayed = this.#delayedHeap(name)
    let promoted = 0
    while ((delayed.peek()?.availableAt ?? Infinity) <= now) {
      const entry = delayed.pop()!
      const job = this.#jobs.get(entry.id)
      if (!job || job.state !== 'delayed' || job.sequence !== entry.sequence || job.availableAt !== entry.availableAt) continue
      this.#writeJob({ ...job, state: 'waiting', updatedAt: now }, job)
      promoted++
    }
    return promoted
  }

  #pushTerminal (job: StoredJob): void {
    if (job.finishedAt !== undefined) this.#terminal.push({ id: job.id, finishedAt: job.finishedAt })
  }

  #compactLeaseIndex (name: string): void {
    const activeCount = this.#counts.get(name)?.active ?? 0
    const heap = this.#leaseHeap(name)
    if (heap.size <= activeCount * 2 + 1_000) return
    const compacted = leaseHeap()
    for (const job of this.#jobs.query({ where: { queueName: name, state: 'active' } })) {
      if (job.lockToken && job.leaseExpiresAt !== undefined) {
        compacted.push({ id: job.id, token: job.lockToken, expiresAt: job.leaseExpiresAt })
      }
    }
    this.#leases.set(name, compacted)
  }

  #compactTerminalIndex (): void {
    if (this.#terminal.size <= this.#terminalCount * 2 + 1_000) return
    const compacted = new MinHeap<TerminalEntry>((a, b) => a.finishedAt - b.finishedAt)
    for (const state of TERMINAL_STATES) {
      for (const job of this.#jobs.query({ where: { state } })) {
        if (job.finishedAt !== undefined) compacted.push({ id: job.id, finishedAt: job.finishedAt })
      }
    }
    this.#terminal = compacted
  }

  #compactQueueIndex (name: string): void {
    const currentPending = (this.#counts.get(name)?.waiting ?? 0) + (this.#counts.get(name)?.delayed ?? 0)
    const heapSize = (this.#ready.get(name)?.size ?? 0) + (this.#delayed.get(name)?.size ?? 0)
    if (heapSize <= currentPending * 2 + 1_000) return
    const ready = readyHeap()
    const delayed = delayedHeap()
    for (const state of ['waiting', 'delayed'] as const) {
      for (const job of this.#jobs.query({ where: { queueName: name, state } })) {
        const entry = { id: job.id, priority: job.priority, sequence: job.sequence }
        if (job.state === 'waiting') ready.push(entry)
        else delayed.push({ ...entry, availableAt: job.availableAt })
      }
    }
    this.#ready.set(name, ready)
    this.#delayed.set(name, delayed)
  }

  #emitSafely (event: string, value: unknown): void {
    if (this.listenerCount(event) === 0) return
    try { this.emit(event, value) } catch (error) { this.#reportError(error) }
  }

  #reportError (value: unknown): void {
    let error: Error
    try { error = value instanceof Error ? value : new Error(String(value)) } catch { error = new Error('Queue operation failed with an unprintable error') }
    if (this.listenerCount('error') > 0) {
      try { this.emit('error', error); return } catch (listenerError) {
        if (this.listenerCount('workerError') === 0) return
        try { this.emit('workerError', listenerError instanceof Error ? listenerError : new Error(String(listenerError))) } catch {}
        return
      }
    }
    if (this.listenerCount('workerError') > 0) {
      try { this.emit('workerError', error) } catch {}
    }
  }

  async #acquireNamespace (): Promise<void> {
    if (this.db.workspaceRoot) {
      const canonicalRoot = await realpath(resolvePath(this.db.workspaceRoot))
      const key = `${canonicalRoot}\0${this.namespace}`
      const owner = ACTIVE_QUEUE_WORKSPACES.get(key)
      assert(!owner || owner === this, `BroccoliQueue namespace "${this.namespace}" already has an owner in this process`)
      ACTIVE_QUEUE_WORKSPACES.set(key, this)
      this.#namespaceRegistryKey = key
      return
    }

    const owners = ACTIVE_QUEUE_DATABASES.get(this.db) ?? new Map<string, BroccoliQueue>()
    const owner = owners.get(this.namespace)
    assert(!owner || owner === this, `BroccoliQueue namespace "${this.namespace}" already has an owner in this process`)
    owners.set(this.namespace, this)
    ACTIVE_QUEUE_DATABASES.set(this.db, owners)
    this.#usesDatabaseRegistry = true
  }

  #releaseNamespace (): void {
    if (this.#namespaceRegistryKey) {
      if (ACTIVE_QUEUE_WORKSPACES.get(this.#namespaceRegistryKey) === this) ACTIVE_QUEUE_WORKSPACES.delete(this.#namespaceRegistryKey)
      this.#namespaceRegistryKey = undefined
    }
    if (this.#usesDatabaseRegistry) {
      const owners = ACTIVE_QUEUE_DATABASES.get(this.db)
      if (owners?.get(this.namespace) === this) owners.delete(this.namespace)
      this.#usesDatabaseRegistry = false
    }
  }

  #scheduleMaintenance (): void {
    if (!this.#started || this.#closing || this.#maintenanceTimer) return
    this.#maintenanceTimer = setInterval(() => { void this.#runMaintenance() }, this.#maintenanceIntervalMs)
    this.#maintenanceTimer.unref?.()
  }

  async #runMaintenance (): Promise<void> {
    if (!this.#started || this.#closing) return
    if (this.#maintenancePromise) return await this.#maintenancePromise
    const operation = (async () => {
      for (let batch = 0; batch < this.#maintenanceMaxBatches && !this.#closing; batch++) {
        const removed = await this.prune({ batchSize: this.#maintenanceBatchSize })
        if (removed < this.#maintenanceBatchSize) break
      }
    })().catch(error => this.#reportError(error))
    this.#maintenancePromise = operation
    try { await operation } finally {
      if (this.#maintenancePromise === operation) this.#maintenancePromise = undefined
    }
  }

  #flushWrites (): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.#flushWaiters.push({ resolve, reject })
    })
    if (!this.#flushRunning && !this.#flushTimer) {
      this.#flushTimer = setTimeout(() => {
        this.#flushTimer = undefined
        void this.#drainFlushWaiters()
      }, this.#flushBatchDelayMs)
    }
    return promise
  }

  async #drainFlushWaiters (): Promise<void> {
    if (this.#flushRunning || this.#flushWaiters.length === 0) return
    this.#flushRunning = true
    const waiters = this.#flushWaiters
    this.#flushWaiters = []
    try {
      await this.db.flush()
      this.#lastPersistenceFailureAt = undefined
      for (const waiter of waiters) waiter.resolve()
    } catch (error) {
      this.#lastPersistenceFailureAt = Date.now()
      for (const waiter of waiters) waiter.reject(error)
    } finally {
      this.#flushRunning = false
      if (this.#flushWaiters.length > 0 && !this.#flushTimer) {
        this.#flushTimer = setTimeout(() => {
          this.#flushTimer = undefined
          void this.#drainFlushWaiters()
        }, this.#flushBatchDelayMs)
      }
    }
  }

  #assertStarted (): void {
    assert(this.#started && !this.#closing, this.#closing
      ? 'BroccoliQueue is closing and no longer accepts operations'
      : 'BroccoliQueue is not started; call await queue.start() first')
  }
}

class QueueWorker implements WorkerHandle {
  readonly id: string
  readonly queueName: string
  #queue: BroccoliQueue
  #processor: JobProcessor
  #concurrency: number
  #batchSize: number
  #pollingIntervalMs: number
  #leaseDurationMs: number
  #running = false
  #paused = false
  #pumpPromise: Promise<void> | undefined
  #stopPromise: Promise<void> | undefined
  #timer: NodeJS.Timeout | undefined
  #active = new Map<string, { token: string; controller: AbortController; task: Promise<void>; heartbeat?: NodeJS.Timeout }>()

  constructor (queue: BroccoliQueue, name: string, processor: JobProcessor, options: WorkerOptions) {
    this.#queue = queue
    this.queueName = name
    this.#processor = processor
    this.#concurrency = options.concurrency ?? 1
    this.#batchSize = options.batchSize ?? 32
    this.#pollingIntervalMs = options.pollingIntervalMs ?? 100
    this.#leaseDurationMs = options.leaseDurationMs ?? 30_000
    this.id = options.workerId ?? `worker-${randomUUID()}`
    assert(typeof this.id === 'string' && this.id.length > 0 && this.id.length <= 128, 'workerId must be 1-128 characters')
    safeInteger(this.#concurrency, 'concurrency', 1, 10_000)
    safeInteger(this.#batchSize, 'batchSize', 1, MAX_PAGE_SIZE)
    safeInteger(this.#pollingIntervalMs, 'pollingIntervalMs', 10, 60_000)
    safeInteger(this.#leaseDurationMs, 'leaseDurationMs', 500, 24 * 60 * 60 * 1_000)
  }

  get isRunning (): boolean {
    return this.#running
  }

  get activeCount (): number {
    return this.#active.size
  }

  get concurrency (): number {
    return this.#concurrency
  }

  async start (): Promise<this> {
    if (this.#stopPromise) await this.#stopPromise
    if (this.#running) return this
    await this.#queue.ensureQueue(this.queueName)
    if (this.#running) return this
    this.#queue.registerWorker(this)
    this.#running = true
    this.#schedule(0)
    return this
  }

  pause (): void {
    this.#paused = true
  }

  resume (): void {
    this.#paused = false
    this.wake()
  }

  wake (): void {
    if (!this.#running) return
    this.#schedule(0)
  }

  async stop (options: { drainTimeoutMs?: number } = {}): Promise<void> {
    const drainTimeoutMs = options.drainTimeoutMs ?? 30_000
    safeInteger(drainTimeoutMs, 'drainTimeoutMs', 0)
    if (this.#stopPromise) return await this.#stopPromise
    if (!this.#running) {
      this.#queue.unregisterWorker(this)
      return
    }
    const operation = this.#stopInternal(drainTimeoutMs)
    this.#stopPromise = operation
    try { await operation } finally {
      if (this.#stopPromise === operation) this.#stopPromise = undefined
    }
  }

  async #stopInternal (drainTimeoutMs: number): Promise<void> {
    this.#running = false
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined

    await this.#pumpPromise?.catch(error => this.#queue.reportWorkerError(error))

    const tasks = [...this.#active.values()].map(active => active.task)
    if (tasks.length && drainTimeoutMs > 0) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.allSettled(tasks),
        new Promise(resolve => {
          timer = setTimeout(resolve, drainTimeoutMs)
        })
      ])
      if (timer) clearTimeout(timer)
    }

    if (this.#active.size) {
      const active = [...this.#active.entries()]
      for (const [, task] of active) {
        if (task.heartbeat) clearTimeout(task.heartbeat)
        task.controller.abort(new Error('Worker stopped before the handler completed'))
      }
      await this.#queue.releaseClaims(active.map(([id, task]) => ({ id, token: task.token })))
        .catch(error => this.#queue.reportWorkerError(error))
    }
    this.#queue.unregisterWorker(this)
  }

  async #pump (): Promise<void> {
    if (!this.#running || this.#pumpPromise) return

    this.#pumpPromise = (async () => {
      // Retry a previously failed WAL flush before mutating more claims. A
      // handler must never start behind an unflushed state transition.
      await this.#queue.flushWrites()
      await this.#queue.recoverExpired(this.queueName, this.#batchSize)
      if (!this.#running || this.#paused) return
      const available = this.#concurrency - this.#active.size
      if (this.#queue.isPaused(this.queueName) || available <= 0) {
        await this.#queue.promoteDue(this.queueName)
        return
      }
      const claimed = this.#queue.claimReady(
        this.queueName,
        this.id,
        Math.min(this.#batchSize, available),
        this.#leaseDurationMs
      )
      if (claimed.length) {
        try {
          await this.#queue.flushWrites()
        } catch (error) {
          await this.#queue.releaseClaims(claimed.map(item => ({ id: item.job.id, token: item.token })), { restoreAttempts: true })
            .catch(releaseError => this.#queue.reportWorkerError(releaseError))
          throw error
        }
      }
      if (!this.#running) {
        await this.#queue.releaseClaims(claimed.map(item => ({ id: item.job.id, token: item.token })), { restoreAttempts: true })
        return
      }
      for (const item of claimed) {
        const live = this.#queue.getJob(item.job.id)
        if (!live || live.state !== 'active') continue
        this.#run(item)
      }
    })()

    try {
      await this.#pumpPromise
    } catch (error) {
      this.#queue.reportWorkerError(error)
    } finally {
      this.#pumpPromise = undefined
      if (this.#running) this.#schedule(this.#pollingIntervalMs)
    }
  }

  #run (claim: ClaimedJob): void {
    const controller = new AbortController()
    const { job, token } = claim
    this.#queue.registerController(job.id, controller)
    const active: { token: string; controller: AbortController; task: Promise<void>; heartbeat?: NodeJS.Timeout } = {
      token,
      controller,
      task: Promise.resolve()
    }
    this.#active.set(job.id, active)
    controller.signal.addEventListener('abort', () => {
      if (active.heartbeat) clearTimeout(active.heartbeat)
    }, { once: true })
    const scheduleHeartbeat = () => {
      if (controller.signal.aborted || this.#active.get(job.id) !== active) return
      active.heartbeat = setTimeout(() => {
        void this.#queue.renewLease(job.id, token, this.#leaseDurationMs).then(renewed => {
          if (!renewed) controller.abort(new Error('Job lease was taken by another worker'))
        }).catch(error => {
          controller.abort(error)
          this.#queue.reportWorkerError(error)
        }).finally(scheduleHeartbeat)
      }, Math.max(250, Math.floor(this.#leaseDurationMs / 3)))
    }
    scheduleHeartbeat()

    active.task = Promise.resolve().then(async () => {
      const context: WorkerContext = {
        signal: controller.signal,
        heartbeat: () => this.#queue.renewLease(job.id, token, this.#leaseDurationMs)
      }
      let result: unknown
      try {
        result = await this.#processor(publicJob(job), context)
      } catch (error) {
        try { await this.#queue.failClaim(job.id, token, error) } catch (settlementError) {
          this.#queue.reportWorkerError(settlementError)
        }
        return
      }
      try {
        await this.#queue.completeClaim(job.id, token, result)
      } catch (settlementError) {
        // A failed persistence flush is ambiguous: the WAL may still contain
        // the completion frame. Do not overwrite it with a synthetic failure.
        this.#queue.reportWorkerError(settlementError)
      }
    }).catch(error => {
      this.#queue.reportWorkerError(error)
    }).finally(() => {
      if (active.heartbeat) clearTimeout(active.heartbeat)
      this.#queue.unregisterController(job.id, controller)
      if (this.#active.get(job.id) === active) this.#active.delete(job.id)
      if (this.#running) this.#schedule(0)
    })
  }

  #schedule (delayMs: number): void {
    if (!this.#running) return
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.#pump()
    }, delayMs)
  }
}
