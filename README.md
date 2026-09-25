# BroccoliQueue

High-throughput background jobs stored in [BroccoliDB](https://github.com/CardSorting/ABroccoliDB) tables. Producers enqueue batches, workers claim jobs and run handlers concurrently, and a same-process dashboard helps operators inspect and recover work.

BroccoliQueue runs inside one Node.js process and shares one BroccoliDB kernel. Delivery is **at least once**. Use it when a queue should share an application's local state; use a server database or broker when workers need to coordinate across processes or machines.

## Table of contents

- [At a glance](#at-a-glance)
- [Quick start](#quick-start)
- [Job lifecycle](#job-lifecycle)
- [Delivery and retries](#delivery-and-retries)
- [Dashboard](#dashboard)
- [API at a glance](#api-at-a-glance)
- [Operations and boundaries](#operations-and-boundaries)
- [Documentation](#documentation)
- [Development](#development)
- [License](#license)

## At a glance

| Capability | What it provides |
|---|---|
| Producers | Single and validated bulk enqueue, stable idempotency keys, per-queue defaults |
| Workers | Bounded handler concurrency, priority and FIFO ordering, delayed work, heartbeat-renewed leases |
| Recovery | At-least-once delivery, fencing tokens, retry backoff, stalled-lease recovery, cooperative cancellation |
| Operations | Queue and job inspection, pause/resume, failed-job retry, retention pruning, health status |
| Dashboard | Same-process queue overview and job/queue actions, with loopback-first access controls |
| Persistence | BroccoliDB tables and local WAL; successful enqueue, claim, heartbeat, and settlement calls wait for a flush |
| Runtime | ESM package for Node.js 22.12 or newer; BroccoliDB 3.x as a peer dependency |

## Quick start

Install BroccoliDB and BroccoliQueue in the application that owns the queue:

```bash
npm install /path/to/BroccoliDB /path/to/BROCCOLIQUEUE
```

Start one BroccoliDB kernel, then start the queue and a worker. The first argument to `add()` and `process()` is the **queue name**.

```ts
import { BroccoliDatabaseKernel } from '@noorm/broccolidb'
import { BroccoliQueue } from 'broccoli-queue'

const db = new BroccoliDatabaseKernel({ workspaceRoot: './state' })
await db.start()

const queue = new BroccoliQueue({ db, namespace: 'mailer' })
await queue.start()

const worker = queue.process<{ to: string }, { messageId: string }>(
  'email.send',
  async (job, { signal }) => {
    return await sendEmail(job.data.to, { signal })
  },
  { concurrency: 8, leaseDurationMs: 60_000 }
)
await worker.start()

const job = await queue.add('email.send', { to: 'ada@example.com' }, {
  attempts: 5,
  backoff: { type: 'exponential', delayMs: 1_000, maxDelayMs: 60_000 },
  idempotencyKey: 'welcome:ada'
})

console.log(job.id)

// Close queue-owned dashboards and workers before stopping the shared database.
await queue.close()
await db.stop()
```

`queue.start()` also calls `db.start()`; the explicit database start above makes the host's lifecycle ownership visible. Queue startup is safe after an idempotent database start.

## Job lifecycle

A queue is created when a job is added or when `createQueue()` is called. Jobs move through familiar states:

```text
waiting ──claim──> active ──success──> completed
   │                  │
   └─ delay ─> delayed├─ retryable error ─> delayed ──eligible──> active
                      ├─ final error ─────> failed ──manual retry──> waiting
                      └─ cancel ──────────> cancelled
```

Use `addBulk()` when a producer has multiple jobs ready together:

```ts
const jobs = await queue.addBulk([
  { name: 'image.resize', data: { imageId: 'img_1' }, options: { priority: 5 } },
  { name: 'image.resize', data: { imageId: 'img_2' }, options: { priority: 5 } },
  { name: 'reports.generate', data: { reportId: 'r_1' }, options: { delayMs: 30_000 } }
])
```

The whole batch is validated before records change, and the accepted records share one BroccoliDB WAL flush. Defaults are 1 MiB per job payload, 1 MiB per result, 1,000 jobs per bulk call, and 16 MiB combined payload per call. Configure bounds with `maxJobDataBytes`, `maxJobResultBytes`, `maxBulkItems`, and `maxBulkBytes`.

## Delivery and retries

Delivery is **at least once**, as in common queue and consumer-group designs. A worker claims a job under a renewable lease and receives an abort signal. If the lease expires, BroccoliQueue can recover the job for another attempt. A fencing token prevents an old worker from renewing or settling work after ownership changes.

An external side effect can finish before the queue persists completion. Make side effects idempotent using `job.id` or a domain key, and pass the supplied `signal` to cancellable operations. A producer `idempotencyKey` makes repeated enqueue calls return the same retained job for the same namespace and queue; it does not make a handler's external effects exactly once.

Retries count the first execution as attempt one. Set `attempts` above one to retry handler failures. Backoff can be fixed or exponential; the default is exponential from one second up to 60 seconds. See [Architecture](docs/architecture.md) for claim, lease, and recovery behavior.

## Dashboard

Attach the dashboard to the running queue instance:

```ts
const dashboard = await queue.startDashboard({ port: 3030 })
console.log(`Queue dashboard: ${dashboard.address}`)

// queue.close() also closes dashboards it started.
await queue.close()
await db.stop()
```

It binds to `127.0.0.1` by default. Direct non-loopback binding requires TLS credentials and a random `authToken` of at least 32 characters. For TLS termination at a reverse proxy, bind the dashboard to loopback, restrict proxy access to trusted users, and configure the exact browser origin with `allowedOrigins` when it differs from the dashboard origin.

The dashboard can enqueue jobs, pause or resume queues, retry failed jobs, cancel active work, and inspect payloads and errors. Payloads may contain secrets: limit dashboard access and keep sensitive values out of jobs when possible. See [Dashboard exposure](docs/operations.md#dashboard-exposure).

## API at a glance

| Method | Purpose |
|---|---|
| `queue.add(queueName, data, options?)` | Add one JSON job and wait for its WAL flush. |
| `queue.addBulk(items)` | Validate and persist a producer batch with one flush. |
| `queue.process(queueName, handler, options?)` | Register a bounded worker; call `start()` to claim jobs. |
| `queue.getJob(id)` / `queue.getJobs(query?)` | Inspect one retained job or page the recent window. |
| `queue.pause(name)` / `queue.resume(name)` | Stop or resume new claims for one queue. |
| `queue.retry(id)` / `queue.cancel(id)` / `queue.delete(id)` | Recover failed work or manage a job. |
| `queue.startDashboard(options?)` | Serve the same queue instance to local operators. |
| `queue.close()` | Close dashboards, stop workers, and flush without stopping BroccoliDB. |

See the [API reference](docs/API.md) for options, defaults, and state semantics.

## Operations and boundaries

- Start one application process per BroccoliDB workspace. BroccoliDB's mutex coordinates work inside one process; it is not a cross-process lock.
- A queue is durable after its operation's BroccoliDB flush completes. A filesystem error can leave the result uncertain; retry producer operations with the same idempotency key.
- `queue.close()` closes dashboards, drains or releases workers, and flushes queue writes. The host remains responsible for `db.stop()`.
- Terminal job records are retained for seven days by default and removed in bounded maintenance batches. After a large prune, use `db.checkpoint()` to compact BroccoliDB's append-only WAL history.
- `getJobs()` serves the most recent 12,000 jobs; `getJob(id)` can fetch any job that remains in the table.

The [operations guide](docs/operations.md) covers lifecycle, backups, health, security, retention, and capacity checks. For BroccoliDB's filesystem and recovery rules, see its [operating guide](https://github.com/CardSorting/ABroccoliDB/blob/main/docs/OPERATIONS.md).

## Documentation

The docs follow a layered path: **Concepts → How it works → Reference → Operations → Decisions**.

- [Documentation map](docs/README.md) — choose a reading path by role.
- [Brief](docs/BRIEF.md) — product fit, guarantees, and non-goals.
- [Architecture](docs/architecture.md) — tables, state transitions, leases, and failure boundaries.
- [API reference](docs/API.md) — methods, options, defaults, and examples.
- [Operations guide](docs/operations.md) — lifecycle, backups, dashboard security, and capacity.
- [Troubleshooting](docs/TROUBLESHOOTING.md) — symptom → cause → action runbooks.
- [Glossary](docs/GLOSSARY.md) — canonical queue vocabulary.
- [Design philosophy](docs/PHILOSOPHY.md) — principles, trade-offs, and reference patterns.
- [Hardening review](docs/hardening-review.md) — security and recovery review record.
- [Performance baseline](docs/performance.md) — one synthetic run and repeatable benchmark command.
- [Contributing](docs/CONTRIBUTING.md) — source map, docs rules, and development workflow.
- [Architecture decisions](docs/adr/README.md) — decisions and their consequences.

## Development

```bash
npm install
npm run build
npm test
npm run docs:check
npm run bench -- --jobs 100000 --batch-size 500 --concurrency 16
```

`npm test` builds the package and runs the tests under `test/`. `npm run docs:check` validates required docs and relative Markdown links. Use representative payloads, handler work, and the target filesystem when benchmarking; the [implementation-machine baseline](docs/performance.md) is not a production capacity target.

## License

BroccoliQueue is licensed under the MIT License. BroccoliDB is a separate peer dependency with its own license; this repository does not copy its implementation.
