# BroccoliQueue

A local durable job queue for Node.js, backed by [BroccoliDB](https://github.com/CardSorting/ABroccoliDB).

BroccoliQueue stores jobs in BroccoliDB tables, runs handlers with bounded concurrency, and includes a dashboard for inspecting and recovering work. It runs in **one Node.js process** and shares one BroccoliDB kernel; use a server database or broker when workers need to coordinate across processes or machines.

## Features

- Durable enqueue and settlement: successful writes are acknowledged after the BroccoliDB WAL flush.
- Concurrent workers with priorities, delayed jobs, renewable leases, and bounded batches.
- At-least-once delivery, retry backoff, stalled-job recovery, cancellation, and producer idempotency keys.
- Queue and job inspection, pause/resume, failed-job retry, retention pruning, and health status.
- A built-in dashboard that binds to loopback by default.

## Requirements

- Node.js 22.12 or newer
- BroccoliDB 3.x (`@noorm/broccolidb`)

## Install

When using local checkouts, build BroccoliDB and BroccoliQueue first, then install both packages in your application:

```bash
npm install /path/to/BroccoliDB /path/to/BROCCOLIQUEUE
```

See [Development](#development) for the checkout and build steps. BroccoliQueue's source setup expects the BroccoliDB checkout in a sibling directory named `BroccoliDB`.

## Quick start

Create a queue, start a worker, and enqueue a job. `queue.start()` starts the supplied BroccoliDB kernel if needed.

```js
import { BroccoliDatabaseKernel } from '@noorm/broccolidb'
import { BroccoliQueue } from 'broccoli-queue'

const db = new BroccoliDatabaseKernel({ workspaceRoot: './state' })
const queue = new BroccoliQueue({ db, namespace: 'mailer' })
await queue.start()

const worker = queue.process('email.send', async (job, { signal }) => {
  signal.throwIfAborted()
  console.log(`Send an email to ${job.data.to}`)
  return { sent: true }
}, { concurrency: 8 })
await worker.start()

const job = await queue.add('email.send', { to: 'ada@example.com' }, {
  attempts: 5,
  idempotencyKey: 'welcome:ada'
})
console.log(`Queued job ${job.id}`)
```

Keep the worker process alive while it handles jobs. In your application's shutdown hook, close the queue before stopping the shared database:

```js
await queue.close({ drainTimeoutMs: 30_000 })
await db.stop()
```

`queue.close()` stops workers and flushes queue writes; the host owns the BroccoliDB lifecycle.

## Delivery and retries

Delivery is **at least once**: a handler may run again after a crash or an expired lease. Make external side effects idempotent, and pass the handler's `AbortSignal` to cancellable work. A producer `idempotencyKey` deduplicates repeated enqueue calls while the corresponding job record is retained; it does not make external effects exactly once.

The queue and dashboard operate on the same in-process state. The dashboard binds to `127.0.0.1` by default. Exposing it beyond loopback requires additional access controls; see [Dashboard exposure](docs/operations.md#dashboard-exposure).

## Documentation

- [Documentation map](docs/README.md) — choose a guide by role or task.
- [Product brief](docs/BRIEF.md) — intended use, guarantees, and non-goals.
- [API reference](docs/API.md) — methods, options, defaults, and examples.
- [Architecture](docs/architecture.md) — job states, leases, recovery, and persistence.
- [Operations guide](docs/operations.md) — lifecycle, backups, security, retention, and capacity.
- [Troubleshooting](docs/TROUBLESHOOTING.md) — symptoms and recovery steps.
- [Contributing](docs/CONTRIBUTING.md) — source map and development workflow.
- [Architecture decisions](docs/adr/README.md) — recorded decisions and trade-offs.

## Development

The queue's development dependency expects `BroccoliDB` and `BROCCOLIQUEUE` checkouts next to each other:

```bash
mkdir broccoli-queue-dev && cd broccoli-queue-dev
git clone https://github.com/CardSorting/ABroccoliDB.git BroccoliDB
git clone https://github.com/CardSorting/BROCCOLIQUEUE.git BROCCOLIQUEUE
(cd BroccoliDB && npm install && npm run build)
(cd BROCCOLIQUEUE && npm install && npm run build)
cd BROCCOLIQUEUE
npm test
npm run docs:check
```

Run a representative benchmark with `npm run bench -- --jobs 100000 --batch-size 500 --concurrency 16`. See the [performance baseline](docs/performance.md) for context; it is not a production capacity target.

## License

BroccoliQueue is licensed under the [MIT License](LICENSE). BroccoliDB is a separate peer dependency with its own license.
