# ADR-001: Keep the queue process-local and delivery at least once

- **Status:** Accepted
- **Date:** 2026-09-25
- **Decision owners:** BroccoliQueue maintainers

## Context

BroccoliQueue exists to add background work to applications that already keep local state in BroccoliDB. BroccoliDB provides in-memory tables, local WAL persistence, and a process-local coordination boundary. It does not provide cross-process locking, replication, or remote consumer groups.

## Decision

Store queue metadata and job records in BroccoliDB and coordinate workers within one Node.js process. Use renewable leases and fencing tokens to recover expired ownership and reject settlements from stale claims. Define delivery as at least once and require application-level idempotency for external side effects.

## Consequences

- Applications can use one persistence lifecycle and inspect queue records alongside other BroccoliDB tables.
- Multiple worker handles can process concurrently inside one queue process, but independent processes must not write the same workspace.
- A job may execute again after lease expiry or when a side effect completes before completion persistence.
- Producer idempotency keys help repeat enqueue calls for a retained job; they do not give exactly-once handler effects.
- Applications that need cross-machine workers, replication, or exactly-once effect transactions need an external broker/database and an idempotent effect boundary.

## Evidence

- [Queue implementation](../../src/queue.ts): claims, leases, fencing tokens, and the single-process owner registry.
- [Regression tests](../../test/queue.test.js): same-workspace ownership, expired leases, retries, flush failures, and persistence across restart.
- [Architecture](../architecture.md): state and recovery behavior.
- Familiar patterns: [BullMQ stalled jobs](https://docs.bullmq.io/guide/workers/stalled-jobs) and [Redis Streams consumer groups](https://redis.io/docs/latest/develop/data-types/streams/).
