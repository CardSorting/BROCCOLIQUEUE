# Troubleshooting

Use these runbooks to move from a symptom to a likely cause and a safe next action. Preserve the BroccoliDB workspace before investigating suspected corruption.

## Startup and persistence

### `queue.start()` fails while replaying BroccoliDB state

**Likely cause:** BroccoliDB found invalid complete WAL data, an unsupported queue schema version, or a database read/parse problem.

**Action:** stop other application components, preserve the full workspace, and inspect the underlying BroccoliDB error. Do not delete WAL or checkpoint files by hand. Follow BroccoliDB's [recovery guidance](https://github.com/CardSorting/ABroccoliDB/blob/main/docs/TROUBLESHOOTING.md) and restore a known-good backup if integrity checks fail.

### An enqueue or worker operation rejects during a WAL flush

**Likely cause:** the filesystem rejected persistence. Its result may still be uncertain if bytes were written before the error surfaced.

**Action:** check `queue.getHealth()` and the host's filesystem logs. Retry producer calls with the same `idempotencyKey`; the returned record reveals whether the original job already exists. Inspect `getJob(id)` when you know its ID. Make external effects idempotent before repeating them. Do not treat the in-memory table as proof that the write is durable.

### The dashboard reports “Storage write issue”

**Likely cause:** the queue's last BroccoliDB WAL flush failed. Queue health remains degraded until a later flush succeeds.

**Action:** repair disk capacity/permissions, then retry a safe operation or restart through the normal lifecycle. Review the host's BroccoliDB diagnostics and keep the workspace intact until state is understood.

## Worker and delivery

### Jobs remain waiting

**Likely causes:** no worker was started, it is attached to another queue name, the queue is paused, the handler's worker handle was never started, or the application is polling a different BroccoliDB workspace.

**Action:** compare the queue name passed to `add()` and `process()`, call `await worker.start()`, check `getWorkers()`, `getQueue(name)?.paused`, and verify there is exactly one intended workspace owner.

### Jobs remain delayed

**Likely cause:** `availableAt` has not arrived because of an initial delay or retry backoff.

**Action:** inspect the job's `availableAt` and `lastError`. Backoff is measured in milliseconds. If a delay is accidental, cancel and enqueue a corrected job; changing a stored job's original options does not reschedule it.

### A handler runs more than once

**Likely cause:** a lease expired, the process stopped after performing an external effect but before persisting completion, or a prior completion flush had an uncertain outcome.

**Action:** make the handler's external effect idempotent using `job.id` or a domain key. Tune `leaseDurationMs` for the handler and keep CPU-heavy work from blocking Node.js's event loop long enough to prevent heartbeat renewal.

### The handler's `signal` is aborted

**Likely cause:** an operator cancelled the job, the lease expired, or the worker was forced to stop after its drain timeout.

**Action:** pass `signal` to cancellable I/O and release local resources in `finally`. An abort asks the handler to stop; it cannot undo an external effect that already happened.

### A job moved to failed after a worker stopped

**Likely cause:** its lease expired after the retry budget was exhausted. The initial run counts as attempt one.

**Action:** inspect `attemptsMade` and `lastError`, correct the underlying issue, then call `retry(id)` or use the dashboard. Manual retry resets attempts and stored result/error fields.

### A stale worker cannot renew or complete a job

**Likely cause:** its lease expired or another attempt owns the job now.

**Action:** treat the failed renewal/settlement as a lost claim. Stop producing effects, honor the aborted signal, and let the current owner settle the job. Never bypass fencing in application code.

## Dashboard and inspection

### Dashboard token is rejected

**Likely cause:** the browser has an old session token or it does not match the queue host's configured `authToken`.

**Action:** use **Set access token** to replace the tab's session token. Confirm the token was sent to the expected local queue and is not being reused across unrelated environments.

### The dashboard cannot bind to a remote interface

**Likely cause:** direct non-loopback access requires both TLS credentials and an `authToken` of at least 32 characters.

**Action:** prefer a TLS-terminating reverse proxy with the dashboard bound to loopback, or provide TLS and a strong random token. Restrict network access and configure exact `allowedOrigins`; the dashboard exposes payloads and mutation actions.

### A job is missing from the Jobs page

**Likely causes:** the job was pruned, the page is within the latest 12,000-job inspection window, or the active filters exclude it.

**Action:** clear state/queue/search filters, use **Load older jobs** to traverse the recent window, and call `getJob(id)` for a known retained ID. A pruned or deleted row is no longer available from the queue table.

### Search does not find an older job

**Likely cause:** dashboard search checks only the jobs currently loaded in its bounded inspection window.

**Action:** load older pages, then search again. For programmatic inspection of a known ID, call `getJob(id)`.

## Retention and concurrency

### Completed jobs disappear

**Likely cause:** automatic retention removes terminal rows after `retentionMs` (seven days by default).

**Action:** set an appropriate retention window. Export records before expiry if the application needs a longer audit history. After a large prune, call `db.checkpoint()` when compacting BroccoliDB's WAL matters.

### Two application processes see inconsistent queue state

**Likely cause:** both processes opened the same BroccoliDB workspace. BroccoliDB's mutex is process-local.

**Action:** stop one process and restore a single writer/owner per workspace. Use a server database or broker for multi-process or multi-host workers.

### Throughput is lower than expected

**Likely causes:** small producer batches, frequent filesystem flushes, CPU-heavy synchronous handler code, oversized JSON payloads, or a mismatch between lease/concurrency settings and external I/O.

**Action:** use `addBulk()`, test `concurrency` and `batchSize` with representative work, keep handler work outside queue mutation paths, and run the included benchmark on the target filesystem. Record p50/p95 enqueue-to-start latency and memory; do not compare a synthetic no-op handler with production processing.
