# BroccoliQueue brief

## Problem

Applications need to accept background work, cap concurrent handlers, retry transient failures, and inspect jobs during development and operations. A separate server broker can solve that problem, but it also introduces a service boundary and its operational costs for applications whose state already lives in BroccoliDB.

## Solution

BroccoliQueue stores queue and job records in BroccoliDB tables. It adds scheduling and recovery in the application process:

1. **Producers** add one job or validate and persist a batch.
2. **Workers** claim only their available handler slots and execute asynchronous handlers.
3. **Leases and fencing tokens** renew ownership and reject settlement from stale workers.
4. **Retries and backoff** reschedule retryable failures and move exhausted work to failed.
5. **Operations** expose counts, job detail, queue pause/resume, retry, cancellation, and a same-process dashboard.

## Guarantees

- A successful `add()` or `addBulk()` return follows a BroccoliDB WAL flush.
- A worker handler starts only after its claim batch flush completes.
- A lease that expires can be recovered; a stale fencing token cannot settle a newer claim.
- Delivery is at least once. External effects can repeat if they finish before completion is recorded.
- Bulk input is fully validated before the first record mutation.
- Job payloads and results are JSON serialized and bounded by configured UTF-8 byte limits.
- The package targets Node.js `>=22.12.0` and depends on BroccoliDB `^3.0.0`.

These guarantees do not make the queue a distributed broker. A flush error can have an uncertain outcome if the filesystem wrote data before reporting failure; see [Operations](operations.md#persistence-health-and-ambiguous-writes).

## Good fit

- Local background work owned by one Node.js application process
- Embedded tools that already persist state through BroccoliDB
- Bounded I/O handlers that benefit from concurrent async execution
- Local retry and inspection workflows without a separate queue service

## Not a fit

- Multiple independent processes or hosts consuming the same workspace
- Exactly-once external side effects without application-level idempotency
- High-availability brokers, replication, or distributed consumer groups
- Durable cron scheduling or multi-step workflow orchestration
- Large binary payload transport

## Decision in one sentence

Use BroccoliQueue when a single Node.js process needs durable, inspectable background jobs alongside BroccoliDB state, and choose a broker or workflow engine when coordination must cross that process boundary.
