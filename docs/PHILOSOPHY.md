# Design philosophy

BroccoliQueue is a local job system for an application that already owns a BroccoliDB kernel. Its design optimizes for inspectable state, bounded work, and a small operational footprint. The single-process boundary is part of the product contract, not a deployment detail.

## Principles

### 1. Make ownership visible

A worker claims a job with a lease, renews that lease while its handler runs, and settles the job with its fencing token. The queue can recover expired ownership, and a stale claim cannot settle a newer attempt. This borrows a familiar at-least-once consumer pattern: record ownership, acknowledge completion, and reclaim stale work.

### 2. Keep effects idempotent

A process can complete an external effect and stop before its queue completion is flushed. Therefore delivery is at least once. Producer idempotency keys help callers retry uncertain enqueue operations; handler idempotency must protect the external system the handler changes.

### 3. Bound the hot paths

Workers claim only as many jobs as there are available handler slots. Producers validate a complete bulk input before the first mutation. Priority, delay, lease, and retention heaps avoid sorting all jobs on each scheduling step. Payloads, results, bulk size, inspection windows, and maintenance batches have explicit limits.

### 4. Keep the lifecycle host-owned

BroccoliQueue calls `db.start()` when it starts, but it does not stop a shared database when the queue closes. The application chooses the workspace path and remains responsible for stopping the BroccoliDB kernel after all components using it have closed.

### 5. Favor familiar operations

The worker lifecycle uses concepts familiar from [BullMQ stalled-job handling](https://docs.bullmq.io/guide/workers/stalled-jobs) and [retry backoff](https://docs.bullmq.io/guide/retrying-failing-jobs): leases, heartbeats, recovery, bounded attempts, and fixed or exponential backoff. The dashboard follows the queue and job inspection shape of [Bull Board](https://github.com/felixmosh/bull-board). The recovery model is also similar to the pending-message ownership pattern in [Redis Streams consumer groups](https://redis.io/docs/latest/develop/data-types/streams/).

These are interaction and reliability references, not compatible APIs or shared storage. BroccoliQueue uses BroccoliDB tables and only coordinates within one Node.js process.

## Rejected alternatives

### A distributed queue backend

Rejected for this package because its purpose is to reuse local BroccoliDB state without operating another server. Choose a broker such as Redis when multiple processes or machines need independent consumers.

### Exactly-once processing

Rejected as a guarantee because queue persistence cannot atomically commit arbitrary network effects. A successful payment/email/API call can precede a crash before completion is written. Use stable application-level idempotency keys for the effects themselves.

### Unbounded payloads and inspection

Rejected because large JSON payloads expand WAL and checkpoint work, while unbounded lists can make operator views slow. Store large artifacts elsewhere and enqueue a small reference; page inspection over the recent window.

### Hidden worker startup

Rejected because worker registration and claiming are distinct operations. `process()` registers the handler; `await worker.start()` makes the claim lifecycle explicit.

## Boundaries

- One BroccoliQueue namespace has one owner per BroccoliDB instance/workspace in a Node.js process.
- The database mutex is process-local; no cross-process lock, replication, or distributed consumer group is provided.
- Delivery may repeat after a lease expiration or an uncertain completion flush.
- Cancellation requests cooperation through `AbortSignal`; it cannot undo an external effect already performed.
- Automatic retention removes terminal rows. BroccoliDB's append-only WAL needs a host-owned checkpoint to compact historical frames.
- The local synthetic benchmark does not predict throughput on another workload or filesystem.

See [Architecture](architecture.md) for mechanics and [Operations](operations.md) for deployment and recovery procedures.
