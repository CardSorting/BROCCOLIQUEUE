# Hardening review

Review date: 2026-09-25

This pass traced producer writes, worker claims and acknowledgements, lease recovery, process shutdown, retention, dashboard requests, and BroccoliDB WAL replay. It repaired the issues below and records the remaining system boundaries so operators can choose the right deployment model.

## Fixes made

- A worker waiting for queue initialization could finish starting after `queue.close()` drained workers. Worker registration now rechecks the queue lifecycle, with a regression test for the blocked-flush race.
- Dashboard access trusted request Host values too broadly. The server now accepts only its bound host and explicitly configured origins, validates browser origins for mutations, rejects cross-site fetch metadata, requires a 32-character token plus TLS for non-loopback binds, limits request sizes and headers, and avoids exposing exception details on server errors.
- The jobs list returned full payloads that the table did not display. List responses now contain only summary fields; payloads and results require an explicit job detail request.
- A bounded retention call alone could not keep up with a high completion rate. Automatic maintenance now runs multiple bounded batches per pass and yields at each WAL flush.
- A torn final WAL write could prevent BroccoliDB startup. Replay now discards only an invalid unterminated tail after validating its complete prefix; a valid unterminated final frame receives a newline repair. Complete-frame integrity failures remain fatal. Recovery counts and byte totals are visible in WAL metrics.
- A checkpoint could rotate away WAL frames written after its table snapshot. Checkpoints now record their WAL frame boundary, retain newer writes, and pause frame assignment only during atomic rotation. Snapshot/history/CAS replacements sync their file before rename and their parent directory where supported.
- Queue bounds now limit individual payload/result size and aggregate bulk payload size before mutation. Failed flushes surface as degraded health, and worker claims are flushed before handlers begin.
- Shutdown is single-flight and closes queue-owned dashboards and workers before the final persistence barrier. Namespace ownership is guarded inside the process.

## Operational limits

- BroccoliQueue coordinates one BroccoliDB kernel in one Node.js process. It does not provide a cross-process lock, replication, distributed consumer groups, or multi-host workers. Two independent processes must not open the same BroccoliDB workspace.
- Delivery is at least once. An external side effect can succeed before completion is persisted. Handlers must make those effects idempotent and should observe the supplied abort signal.
- A rejected filesystem flush can have an uncertain outcome. Retrying producer writes should use a stable idempotency key; callers must not treat in-memory visibility as proof of durability.
- Torn-tail recovery intentionally repairs only the final unterminated frame. A malformed newline-terminated record, checksum error, sequence gap, or chain mismatch stops startup and requires investigation or restore from a known-good backup.
- BroccoliDB keeps its WAL until the host checkpoints. Large retention cleanup should be followed by a checkpoint when reclaiming on-disk history matters.
- Jobs/results are JSON documents, not a blob transport. Keep them small and store large artifacts in CAS or object storage by reference.

## Production checks

Before deployment, set a stable BroccoliDB workspace, use one application process per workspace, choose payload and retention bounds for the workload, protect dashboard credentials, and test shutdown with handlers that honor cancellation. Benchmark against the target filesystem and representative handler I/O; synthetic throughput is not a service guarantee.
