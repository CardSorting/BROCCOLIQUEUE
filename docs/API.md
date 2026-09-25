# API reference

BroccoliQueue exports a small typed surface from `broccoli-queue`. The implementation in `src/queue.ts` is authoritative when an example and a contract disagree.

## Contents

- [Create and start a queue](#create-and-start-a-queue)
- [Producers](#producers)
- [Workers](#workers)
- [Inspection and operations](#inspection-and-operations)
- [Dashboard](#dashboard)
- [Configuration reference](#configuration-reference)
- [Public types](#public-types)

## Create and start a queue

```ts
import { BroccoliDatabaseKernel } from '@noorm/broccolidb'
import { BroccoliQueue } from 'broccoli-queue'

const db = new BroccoliDatabaseKernel({ workspaceRoot: './state' })
await db.start()

const queue = new BroccoliQueue({
  db,
  namespace: 'billing',
  defaultJobOptions: {
    attempts: 4,
    backoff: { type: 'exponential', delayMs: 1_000, maxDelayMs: 30_000 }
  }
})
await queue.start()
```

The database is supplied by the host. `queue.start()` calls `db.start()`, creates or loads its namespaced tables, rebuilds counts and scheduling heaps, and waits for its startup writes to flush. The default namespace is `broccoli_queue`; a namespace must contain 1–48 ASCII letters, digits, underscores, or hyphens. Use a stable, unique namespace when one kernel hosts more than one queue.

## Producers

### `add(queueName, data, options?)`

Add one JSON-compatible payload and return its job record after the WAL flush completes.

```ts
const job = await queue.add('email.send', { to: 'ada@example.com' }, {
  attempts: 5,
  idempotencyKey: 'welcome:ada'
})
```

The first argument is the queue name. Adding to an unknown queue creates that queue.

### `addBulk(items)`

Validate all entries first, add the accepted jobs, and await one WAL flush. Each item is `{ name: queueName, data, options? }`. Validation errors reject before any item is mutated. A successful call returns records for the full input after its WAL flush; a persistence failure can still reject after the in-memory mutations, so treat that outcome as uncertain. Calls with a duplicate idempotency key return the existing job record.

### Job options

| Option | Default | Contract |
|---|---:|---|
| `priority` | `0` | Signed 32-bit integer. Larger values run first; equal priorities keep FIFO order. |
| `delayMs` | `0` | Non-negative integer delay before the job is eligible. |
| `attempts` | `1` | Integer from 1 to 1,000; includes the first execution. |
| `backoff` | Exponential, 1,000 ms, max 60,000 ms | `fixed` or `exponential`; `maxDelayMs` caps exponential delay. |
| `idempotencyKey` | None | Non-empty string up to 256 characters. Scoped to namespace and queue while the job record exists. |

Job and result values are cloned through JSON serialization. Each payload defaults to a maximum of 1 MiB; each result defaults to 1 MiB. One `addBulk()` defaults to at most 1,000 items and 16 MiB combined payload. Configure these bounds on `QueueOptions`.

### Idempotency behavior

A stable key maps to one job ID within a namespace and queue. Repeating `add()` or an item in `addBulk()` with that key returns the existing job without replacing its original data or options. The key protects producer retries while the record remains stored; deleting or pruning the record allows that work key to be enqueued again. It does not deduplicate external handler effects.

## Workers

### `process(queueName, handler, options?)`

Register a handler and return a `WorkerHandle`. Call `start()` to begin claiming jobs.

```ts
const worker = queue.process<{ paymentId: string }, { receiptId: string }>(
  'billing.capture',
  async (job, { signal, heartbeat }) => {
    signal.throwIfAborted()
    const receipt = await provider.capture(job.data.paymentId, {
      idempotencyKey: job.id,
      signal
    })
    await heartbeat()
    return { receiptId: receipt.id }
  },
  { concurrency: 8, batchSize: 64, leaseDurationMs: 60_000 }
)
await worker.start()
```

`WorkerContext.signal` is aborted on cancellation, lease loss, or forced shutdown. The worker renews the lease automatically, and `heartbeat()` can request an immediate renewal. Check and pass the signal to cancellable I/O. A handler can still produce external effects after cancellation if it ignores the signal.

| Worker option | Default | Contract |
|---|---:|---|
| `concurrency` | `1` | Number of handlers this worker may run at once; integer from 1 to 10,000. |
| `batchSize` | `32` | Maximum jobs claimed in one persistence batch; integer from 1 to 500. |
| `pollingIntervalMs` | `100` | Idle polling interval; integer from 10 to 60,000. New local work wakes workers immediately. |
| `leaseDurationMs` | `30,000` | Lease time, renewed automatically while a handler is active; integer from 500 ms to 24 hours. |
| `workerId` | Generated ID | Optional stable label up to 128 characters, shown during job inspection. |

Worker controls:

- `start()` begins claiming eligible work.
- `pause()` stops this worker from claiming new jobs; active handlers continue.
- `resume()` restarts this worker's pump.
- `stop({ drainTimeoutMs })` waits up to the timeout, aborts remaining handlers, and releases their claims for retry. The default timeout is 30 seconds.

## Inspection and operations

| Method | Result |
|---|---|
| `createQueue(name, options?)` | Create a queue or return its existing summary. Supports `paused` and queue-level `defaultJobOptions`. |
| `getQueues()` / `getQueue(name)` | Read queue summaries and state counts. |
| `getOverview()` | Return queues, workers, totals, start time, and health. |
| `getWorkers()` | Read worker IDs, active counts, concurrency, and run state. |
| `getJob(id)` | Read any job still present in the jobs table, or `null`. |
| `getJobs(query?)` | Read up to 500 jobs from the most recent 12,000-job inspection window; default page size is 50. |
| `pause(name)` / `resume(name)` | Persist queue pause state. Pausing prevents new claims and lets active handlers continue. |
| `retry(id, { delayMs? })` | Retry failed jobs, reset attempts and error/result fields, and return `{ retried, job }`. |
| `cancel(id)` | Cancel waiting, delayed, or active work. Active local handlers receive an abort signal. |
| `cancelWaiting(id)` | Atomically cancel waiting or delayed work only. Returns `false` if a worker already claimed the job. |
| `delete(id)` | Delete non-active work. Returns `false` for a missing or active job. |
| `prune({ retentionMs?, batchSize? })` | Remove expired or over-cap terminal records; defaults to 250 rows per call, with a maximum batch of 5,000. |
| `getHealth()` | Report `starting`, `healthy`, `degraded`, `closing`, or `stopped`. |
| `close({ drainTimeoutMs? })` | Close dashboards started by this queue, stop workers, and flush writes. Does not stop the host's database. |

`getJobs()` accepts `queueName`, `state` (one state or an array), `limit`, `offset`, and `beforeId`. The recent inspection window is a deliberate bound; use `getJob(id)` for any known retained record.

## Dashboard

`startDashboard(options?)` serves the dashboard from the same queue instance and returns a `DashboardHandle` with `address` and `close()`. Options are:

| Option | Default | Contract |
|---|---|---|
| `host` | `127.0.0.1` | Direct non-loopback binds require both TLS and a token. |
| `port` | `3030` | Integer from 0 to 65,535; `0` asks the OS for a free port. |
| `authToken` | None | Bearer token. Required for non-loopback access and must be at least 32 characters there. |
| `allowedOrigins` | Dashboard origin | Exact HTTP(S) browser origins permitted by the server. |
| `tls` | None | Certificate and private key for direct HTTPS serving. |

See [Dashboard exposure](operations.md#dashboard-exposure) before exposing the dashboard beyond loopback. It displays payloads and supports state-changing actions.

## Configuration reference

| Queue option | Default | Contract |
|---|---:|---|
| `namespace` | `broccoli_queue` | Table prefix; 1–48 letters, numbers, underscores, or hyphens. |
| `defaultJobOptions` | `{}` | Instance defaults merge with queue-specific defaults, then per-job values override both. |
| `retentionMs` | `604,800,000` (7 days) | Retention window for terminal jobs. |
| `maxTerminalJobs` | unset | Optional cap on retained completed, failed, and cancelled jobs; oldest terminal records are pruned first. |
| `flushBatchDelayMs` | `0` | Coalesce concurrent queue writes before `db.flush()`; 0–1,000 ms. |
| `maxJobDataBytes` | `1,048,576` | Maximum serialized payload size. |
| `maxJobResultBytes` | `1,048,576` | Maximum serialized handler result size. |
| `maxBulkItems` | `1,000` | Maximum jobs per `addBulk()`. |
| `maxBulkBytes` | `16,777,216` | Maximum combined serialized payload per bulk call. |
| `maintenanceIntervalMs` | `5,000` | Automatic terminal-job retention check interval. |
| `maintenanceBatchSize` | `5,000` | Maximum rows removed in one maintenance batch. |
| `maintenanceMaxBatches` | `5` | Maximum maintenance batches in one pass. |

## Public types

The package entry point exports `BroccoliQueue`, `JobProcessor`, and these types:

- `AddJob`, `BackoffOptions`, `JobOptions`, `JobQuery`, `JobState`, `JsonValue`
- `Job`, `JobError`, `QueueHealth`, `QueueStateCounts`, `QueueSummary`, `RetryResult`
- `QueueOptions`, `WorkerOptions`, `WorkerContext`, `WorkerHandle`
- `BroccoliDatabase`, `DashboardOptions`, `DashboardHandle`

The package provides a structural BroccoliDB contract to keep its public type surface small. Consumers should supply BroccoliDB `^3.0.0`; the source of truth for runtime exports is [`src/index.ts`](../src/index.ts).
