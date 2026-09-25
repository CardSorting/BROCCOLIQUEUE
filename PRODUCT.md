# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Working assumption: Node.js application developers who need to enqueue work against an existing BroccoliDB kernel, then inspect and recover jobs during development or operations.

## Product Purpose

BroccoliQueue is a high-throughput background job queue that stores job records in BroccoliDB tables. Success means application code can enqueue batches, run bounded concurrent handlers, recover expired work, and inspect queue health without adding a separate database service.

## Positioning

The queue uses BroccoliDB's in-process table and WAL model directly. It is embedded in one Node.js process and shares that process's BroccoliDB lifecycle.

## Operating Context

Applications construct and start one BroccoliDatabaseKernel, pass it to BroccoliQueue, enqueue JSON-compatible payloads, and register local workers. A mounted dashboard observes and manages that same queue instance.

## Capabilities and Constraints

- Product name is a working name derived from the requested BROCCOLIQUEUE destination.
- BroccoliDB is the sole storage target. There are no SQL backends, SQL drivers, or ORM adapters.
- BroccoliDB provides in-memory tables backed by a local WAL and a process-local transaction mutex. It does not provide cross-process coordination or replication. Queue workers therefore share one kernel in one Node.js process.
- Delivery is at least once. Handlers must be idempotent; leases and fencing tokens prevent stale workers from settling a job after ownership changes.
- Queue payloads and results must be JSON serializable.
- A local synthetic throughput baseline was measured during implementation and recorded in `docs/performance.md`. It is not a production capacity target; performance claims must be tied to measurements on the user's workload and hardware.
- Cron scheduling, workflow graphs, and cross-process workers are open scope decisions.

## Brand Commitments

Working name: BroccoliQueue. The visual identity may use the broccoli name, but the dashboard should remain a familiar, dense operations tool.

## Evidence on Hand

- BroccoliDB source and operating guidance at `/Users/bozoegg/Desktop/BroccoliDB`.
- Existing pg-boss implementation and dashboard in the source checkout.
- Synthetic local baseline on Node.js v24.16.0/macOS arm64; see `docs/performance.md` for workload and limits.
- No customer data, workload-specific capacity target, or service-level target was provided.

## Product Principles

- Make job ownership and state transitions visible.
- Batch database writes on producer and worker hot paths.
- Keep handler work outside the queue's synchronous claim path.
- Make retry, cancellation, and shutdown behavior explicit.
- State BroccoliDB's single-process boundary wherever setup or scaling is described.
