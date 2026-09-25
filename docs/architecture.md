# Architecture

BroccoliQueue stores queue metadata and jobs in BroccoliDB tables. There is one persistence implementation and one coordination boundary: a single BroccoliDatabaseKernel in one Node.js process.

## Contents

- [Storage and hot path](#storage-and-hot-path)
- [State and recovery](#state-and-recovery)
- [Durability and failures](#durability-and-failures)
- [BroccoliDB boundary](#broccolidb-boundary)
- [Operational costs](#operational-costs)

## Storage and hot path

Each namespace uses three BroccoliDB tables: jobs, queues, and a schema-version record. The jobs table has a state index and a composite queue/state index for bounded maintenance queries. Runtime heaps order ready jobs by priority and FIFO sequence, delayed jobs by availability, active leases by expiry, and terminal jobs by retention age. These heaps are rebuilt from the tables on startup and compacted when stale entries cross a threshold; claim and recovery paths do not sort or scan the full job table.

Producers validate JSON payloads and options before table mutation. `addBulk()` validates the complete batch, mutates accepted records, and then waits for one WAL flush. Concurrent operations can share the configurable `flushBatchDelayMs` window, which is 0 ms by default. Each caller still waits for its write barrier.

Worker pumps flush pending WAL writes before recovery and claims. They recover a bounded number of expired leases, claim only free handler slots, persist that claim batch, and invoke handlers only after it is flushed. Handler work runs outside the synchronous claim path.

## State and recovery

```text
waiting ──claim──> active ──success──> completed
   │                  │
   └─ delay ─> delayed├─ retryable error ─> delayed ──eligible──> active
                      ├─ final error ─────> failed ──manual retry──> waiting
                      └─ cancel ──────────> cancelled
```

Higher priority jobs run first; equal priorities preserve insertion order. Delayed jobs become eligible at `availableAt`. The first handler execution counts as attempt one; when a retry remains, a fixed or exponential backoff places the job in delayed state.

Active jobs carry a worker ID, lease expiration, and unpredictable fencing token. A worker renews the lease while its handler runs. An expired token cannot renew or settle a job after the lease ends, even before another worker recovers the record. Expired leases are requeued with backoff or moved to failed when attempts are exhausted; the local handler receives an abort signal. Completion and failure compare the fencing token before writing.

This follows familiar at-least-once consumer patterns: record ownership, acknowledge successful work, and recover stale work. Similar pending-work recovery appears in [Redis Streams consumer groups](https://redis.io/docs/latest/develop/data-types/streams/). Lease renewal, stalled-job recovery, bounded retries, and backoff use concepts documented by [BullMQ](https://docs.bullmq.io/guide/workers/stalled-jobs) and [BullMQ retrying](https://docs.bullmq.io/guide/retrying-failing-jobs). The dashboard follows the queue/job inspection shape of [Bull Board](https://github.com/felixmosh/bull-board). These are design references; BroccoliQueue uses its own BroccoliDB tables and does not provide cross-process consumer groups or API compatibility.

Delivery is at least once. A handler can complete an external effect and stop before queue completion is persisted. Handlers must make those effects idempotent; the queue does not claim exactly-once processing.

## Durability and failures

Queue methods wait for the BroccoliDB WAL flush before reporting successful enqueue, claim, heartbeat, or settlement. If a flush rejects, queue health becomes degraded and the operation rejects. A filesystem call can fail after writing bytes, so callers should treat the result as uncertain and use producer idempotency keys. The worker pump retries pending WAL writes before claiming additional work and does not invoke handlers until the claim batch is durable.

BroccoliDB replays newline-delimited WAL frames with checksum and chain validation. Its startup recovery can remove an invalid unterminated final record after validating the complete prefix, or repair a valid final record missing its newline. Invalid complete records remain fatal. For backup and recovery procedures, see [Operations](operations.md) and BroccoliDB's [operations guide](https://github.com/CardSorting/ABroccoliDB/blob/main/docs/OPERATIONS.md).

## BroccoliDB boundary

BroccoliDB provides in-memory indexed tables, a local WAL, checkpointing, and process-local transactions. It does not provide cross-process locking, replication, or remote workers. Multiple worker handles attached to one queue instance share a JavaScript event loop and the BroccoliDB kernel. Multiple independent application processes must not open the same BroccoliDB workspace.

`queue.close()` closes dashboards started by the queue, stops worker handles, and flushes pending queue writes. It does not call `db.stop()`, because the host may share that database with other components. The host starts and stops the kernel.

## Operational costs

- Producer and worker batches reduce WAL flush calls, but each explicit flush still performs local filesystem work.
- Queue counts and scheduling heaps rebuild once from stored jobs on startup. `getJobs()` serves a bounded recent window of up to 12,000 records; `getJob(id)` can inspect any retained row.
- Terminal jobs are pruned in bounded batches after the configured retention window. BroccoliDB's append-only WAL is compacted only when the host checkpoints.
- Payloads and results are JSON documents. Large values increase WAL and checkpoint cost; store artifacts in BroccoliDB CAS or another object store and enqueue a small reference.
- A local benchmark is not a throughput promise. Measure representative payloads, filesystem, concurrency, batch size, and handler work.
