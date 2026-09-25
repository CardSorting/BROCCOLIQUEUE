# Operations guide

BroccoliQueue is embedded in its host process. There is no separate service to start, but there is an explicit queue lifecycle, a BroccoliDB workspace to protect, and a same-process dashboard to secure.

## Contents

- [Startup and shutdown](#startup-and-shutdown)
- [Workspace ownership](#workspace-ownership)
- [Durability and backup](#durability-and-backup)
- [Retries and stalled jobs](#retries-and-stalled-jobs)
- [Dashboard exposure](#dashboard-exposure)
- [Persistence health and ambiguous writes](#persistence-health-and-ambiguous-writes)
- [Retention and WAL compaction](#retention-and-wal-compaction)
- [Capacity checks](#capacity-checks)

## Startup and shutdown

Start one BroccoliDatabaseKernel for the application's state directory, start BroccoliQueue, register workers, then start the dashboard if needed.

```ts
await db.start()
const queue = new BroccoliQueue({ db, namespace: 'media' })
await queue.start()

const worker = queue.process('image.resize', resizeImage, {
  concurrency: 12,
  leaseDurationMs: 60_000
})
await worker.start()

const dashboard = await queue.startDashboard({ port: 3030 })
```

Stop accepting producer requests before shutdown. Close the dashboard and queue before stopping the shared BroccoliDB kernel. `queue.close()` closes dashboards it started and stops all worker handles. The default drain timeout is 30 seconds; remaining handlers are aborted and their claims released after that timeout. A worker should respond to its `AbortSignal`.

```ts
try {
  // application lifetime
} finally {
  await dashboard?.close()
  await queue.close({ drainTimeoutMs: 30_000 })
  await db.stop()
}
```

Closing a dashboard explicitly before `queue.close()` is optional because the queue tracks and closes dashboards it started. It can be useful when the host stops dashboard access before draining worker tasks.

## Workspace ownership

Choose an explicit `workspaceRoot` for BroccoliDB in production. Keep one application process as its owner. BroccoliDB's internal mutex is process-local; opening the same state directory from a second process can cause divergent in-memory state and WAL writes.

A BroccoliQueue namespace creates `<namespace>_jobs`, `<namespace>_queues`, and `<namespace>_meta` tables. Use a stable, unique namespace when multiple queue instances share one kernel. A namespace separates table names; it does not add cross-process coordination.

## Durability and backup

`add()`, `addBulk()`, worker claim batches, heartbeats, and settlement methods wait for the shared BroccoliDB flush before they report success. Concurrent calls may share the default 0 ms `flushBatchDelayMs` window. The setting is configurable from 0 to 1,000 ms.

The queue does not call an enqueue durable until its operation's flush completes. A process crash before the flush may lose recently mutated in-memory state. A filesystem error can occur after some bytes reached disk, so a rejected result can be uncertain.

For a consistent backup:

1. Stop the owning application or quiesce producers and workers.
2. Await `db.flush()` and preferably `db.checkpoint('queue-backup')`.
3. Copy the complete BroccoliDB `.broccolidb/` directory from the configured workspace.
4. Record BroccoliDB, BroccoliQueue, and Node.js versions with the backup.
5. Test restoration into an isolated workspace before relying on the backup.

For BroccoliDB's detailed file-level recovery rules, use its [backup and restore guidance](https://github.com/CardSorting/ABroccoliDB/blob/main/docs/OPERATIONS.md#backup-and-restore).

## Retries and stalled jobs

Set `attempts` and `backoff` for jobs that should retry. The first execution counts as attempt one. A handler error or an expired lease uses the same retry budget. Default backoff is exponential, starting at 1,000 ms and capped at 60,000 ms.

Tune `leaseDurationMs` for handler duration and allow time for the automatic heartbeat, which runs while the handler is active. CPU-heavy synchronous code can block the Node.js event loop and delay renewals. Use `signal` to stop cancellable I/O when a lease is lost, a job is cancelled, or shutdown passes its drain timeout.

Failed jobs remain inspectable until retention removes them. `queue.retry(id)` moves a failed job to waiting (or delayed with `delayMs`) and resets its attempt counter, previous error, and result. Cancelling active work invalidates its fencing token and sends an abort signal; the queue cannot roll back effects the handler has already performed.

## Dashboard exposure

The dashboard serves job payloads and supports mutations. It binds to loopback by default. Direct non-loopback binding requires TLS credentials and a random `authToken` of at least 32 characters. Prefer a trusted TLS-terminating reverse proxy with the Node.js dashboard bound to loopback.

When a proxy changes the browser-facing origin, set `allowedOrigins` to the exact HTTP(S) origin, including scheme and port. The server validates Host values, validates Origin on mutation requests, rejects cross-site fetch metadata, limits request bodies and headers, and uses a per-response content security policy.

The dashboard uses a bearer token when `authToken` is configured. Keep it in a secret store and send it only over HTTPS outside loopback. A token does not replace network restrictions, TLS, or browser-origin checks. Avoid storing credentials or unnecessary personal information in payloads because job details are visible in the dashboard.

## Persistence health and ambiguous writes

`queue.getHealth()` and `queue.getOverview().health` report `starting`, `healthy`, `degraded`, `closing`, or `stopped`. A failed BroccoliDB flush rejects the operation and records the last persistence failure time. A later successful flush clears the degraded condition.

If enqueue fails during a flush, retry with the same stable `idempotencyKey` and inspect the resulting record. For handler side effects, use a domain idempotency key as well: delivery is at least once, including when the completion result is uncertain.

See [Troubleshooting](TROUBLESHOOTING.md#startup-and-persistence) for step-by-step runbooks.

## Retention and WAL compaction

Terminal jobs are retained for seven days by default. Automatic maintenance checks every five seconds and may remove up to five batches of 5,000 expired terminal rows in a pass. Configure `retentionMs`, `maintenanceIntervalMs`, `maintenanceBatchSize`, and `maintenanceMaxBatches`, or call `queue.prune({ retentionMs, batchSize })` directly.

Queue records remain after job pruning so pause state and queue identity survive cleanup. BroccoliDB's WAL is append-only until the host creates a checkpoint. After pruning a large history, checkpoint during a quiet period if reclaiming on-disk history matters.

## Capacity checks

Measure producer and completion throughput with representative JSON payloads, filesystem, and handler work. Record Node.js version, machine/filesystem, payload size, worker concurrency, batch size, flush delay, memory use, and p50/p95 enqueue-to-start latency.

```bash
npm run bench -- --jobs 100000 --batch-size 500 --concurrency 16 --payload-bytes 128 --flush-batch-delay-ms 0
```

The included run in [Performance baseline](performance.md) is one synthetic reference point, not a production SLA.
