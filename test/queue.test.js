import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BroccoliDatabaseKernel } from '@noorm/broccolidb'
import { BroccoliQueue } from '../dist/index.js'

async function createRuntime (options = {}) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'broccoli-queue-'))
  const db = new BroccoliDatabaseKernel({ workspaceRoot })
  const queue = new BroccoliQueue({ db, ...options })
  await queue.start()
  return { workspaceRoot, db, queue }
}

async function closeRuntime (runtime) {
  await runtime.queue.close().catch(() => {})
  await runtime.db.stop().catch(() => {})
  await rm(runtime.workspaceRoot, { recursive: true, force: true })
}

async function waitFor (predicate, timeoutMs = 3_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('condition did not become true before timeout')
}

test('validates an entire producer batch before changing BroccoliDB tables', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const circular = {}
  circular.self = circular

  await assert.rejects(runtime.queue.addBulk([
    { name: 'valid', data: { value: 1 } },
    { name: 'invalid', data: circular }
  ]), /JSON serializable/)

  assert.deepEqual(runtime.queue.getQueues(), [])
  assert.deepEqual(runtime.queue.getJobs(), [])
})

test('bulk enqueue copies payloads, preserves idempotency, and reports state counts', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const payload = { nested: { count: 1 } }
  const jobs = await runtime.queue.addBulk([
    { name: 'ingest', data: payload, options: { idempotencyKey: 'event-1' } },
    { name: 'ingest', data: { nested: { count: 2 } }, options: { idempotencyKey: 'event-2' } }
  ])
  payload.nested.count = 99
  const duplicate = await runtime.queue.add('ingest', { nested: { count: 100 } }, { idempotencyKey: 'event-1' })

  assert.equal(duplicate.id, jobs[0].id)
  assert.deepEqual(runtime.queue.getJob(jobs[0].id).data, { nested: { count: 1 } })
  assert.deepEqual(runtime.queue.getQueue('ingest').counts, {
    waiting: 2, delayed: 0, active: 0, completed: 0, failed: 0, cancelled: 0
  })
})

test('concurrent enqueue calls share one durable WAL sync window', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const flush = runtime.db.flush.bind(runtime.db)
  let flushCount = 0
  runtime.db.flush = async () => {
    flushCount++
    await flush()
  }

  const jobs = await Promise.all(Array.from({ length: 32 }, (_, index) =>
    runtime.queue.add('coalesced', { index })
  ))

  assert.equal(jobs.length, 32)
  assert.ok(flushCount < jobs.length, `expected fewer than 32 flushes, observed ${flushCount}`)
  assert.equal(runtime.queue.getQueue('coalesced').counts.waiting, 32)
})

test('enforces job, batch, and bulk bounds before creating queues', async t => {
  const runtime = await createRuntime({ maxJobDataBytes: 32, maxBulkItems: 2, maxBulkBytes: 40 })
  t.after(() => closeRuntime(runtime))

  await assert.rejects(runtime.queue.add('oversized', 'x'.repeat(33)), /configured 32-byte limit/)
  await assert.rejects(runtime.queue.addBulk([
    { name: 'oversized-batch', data: 'x'.repeat(21) },
    { name: 'oversized-batch', data: 'y'.repeat(21) }
  ]), /addBulk payload exceeds/)
  await assert.rejects(runtime.queue.addBulk([
    { name: 'too-many', data: 1 },
    { name: 'too-many', data: 2 },
    { name: 'too-many', data: 3 }
  ]), /addBulk item count/)

  assert.deepEqual(runtime.queue.getQueues(), [])
  assert.deepEqual(runtime.queue.getJobs(), [])
})

test('a throwing event listener cannot turn a durable enqueue into a rejection', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  let reported = false
  runtime.queue.on('job', () => { throw new Error('broken observer') })
  runtime.queue.on('workerError', () => { reported = true })

  const job = await runtime.queue.add('listener-safe', { value: 1 })
  assert.equal(runtime.queue.getJob(job.id).state, 'waiting')
  assert.equal(reported, true)
})

test('blocks a second queue owner for the same workspace and namespace', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const competingDb = new BroccoliDatabaseKernel({ workspaceRoot: runtime.workspaceRoot })
  const competingQueue = new BroccoliQueue({ db: competingDb, namespace: runtime.queue.namespace })
  t.after(() => competingDb.stop().catch(() => {}))

  await assert.rejects(competingQueue.start(), /already has an owner in this process/)
})

test('a worker cannot finish starting after queue shutdown begins', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const originalFlush = runtime.db.flush.bind(runtime.db)
  let releaseFlush
  let signalFlushStarted
  const flushGate = new Promise(resolve => { releaseFlush = resolve })
  const flushStarted = new Promise(resolve => { signalFlushStarted = resolve })
  runtime.db.flush = async () => {
    signalFlushStarted()
    await flushGate
    await originalFlush()
  }

  const worker = runtime.queue.process('startup-race', async () => undefined)
  const starting = worker.start()
  await flushStarted
  const closing = runtime.queue.close()
  releaseFlush()

  await assert.rejects(starting, /closing/)
  await closing
  assert.equal(worker.isRunning, false)
  assert.deepEqual(runtime.queue.getWorkers(), [])
})

test('idempotent queue creation waits for the creating call to flush', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const originalFlush = runtime.db.flush.bind(runtime.db)
  let releaseFlush
  let signalFlushStarted
  const flushGate = new Promise(resolve => { releaseFlush = resolve })
  const flushStarted = new Promise(resolve => { signalFlushStarted = resolve })
  runtime.db.flush = async () => {
    signalFlushStarted()
    await flushGate
    await originalFlush()
  }

  const first = runtime.queue.createQueue('created-once')
  await flushStarted
  let secondResolved = false
  const second = runtime.queue.createQueue('created-once').then(value => { secondResolved = true; return value })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(secondResolved, false)

  releaseFlush()
  const [firstQueue, secondQueue] = await Promise.all([first, second])
  runtime.db.flush = originalFlush
  assert.equal(firstQueue.name, secondQueue.name)
})

test('surfaces and recovers a failed BroccoliDB flush without losing idempotency', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const originalFlush = runtime.db.flush.bind(runtime.db)
  let failNext = true
  runtime.db.flush = async () => {
    if (failNext) { failNext = false; throw new Error('simulated WAL failure') }
    await originalFlush()
  }

  await assert.rejects(runtime.queue.add('flush-retry', { value: 1 }, { idempotencyKey: 'stable-flush-key' }), /simulated WAL failure/)
  assert.equal(runtime.queue.getHealth().status, 'degraded')
  await runtime.queue.flushWrites()
  assert.equal(runtime.queue.getHealth().status, 'healthy')
  const saved = runtime.queue.getJobs({ queueName: 'flush-retry', limit: 1 })[0]
  const retry = await runtime.queue.add('flush-retry', { value: 2 }, { idempotencyKey: 'stable-flush-key' })
  assert.equal(retry.id, saved.id)
  assert.deepEqual(retry.data, { value: 1 })
})

test('does not start a handler until a failed claim flush has been recovered', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const job = await runtime.queue.add('claim-flush', { value: 1 }, { attempts: 1 })
  const originalFlush = runtime.db.flush.bind(runtime.db)
  let flushCount = 0
  runtime.db.flush = async () => {
    flushCount++
    if (flushCount === 3) throw new Error('simulated claim flush failure')
    await originalFlush()
  }
  let calls = 0
  const worker = runtime.queue.process('claim-flush', async () => { calls++ }, { pollingIntervalMs: 10 })
  await worker.start()
  await waitFor(() => runtime.queue.getJob(job.id).state === 'completed')
  await worker.stop()

  assert.equal(calls, 1)
  assert.equal(runtime.queue.getJob(job.id).attemptsMade, 1)
  assert.equal(runtime.queue.getJob(job.id).state, 'completed')
})

test('claims by priority and FIFO order, with handlers running at bounded concurrency', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const started = []
  const jobs = await runtime.queue.addBulk([
    { name: 'render', data: { label: 'first' }, options: { priority: 1 } },
    { name: 'render', data: { label: 'high' }, options: { priority: 9 } },
    { name: 'render', data: { label: 'last' }, options: { priority: 1 } }
  ])

  const worker = runtime.queue.process('render', async job => {
    started.push(job.data.label)
    await new Promise(resolve => setTimeout(resolve, 8))
  }, { concurrency: 1, pollingIntervalMs: 10 })
  await worker.start()
  await waitFor(() => runtime.queue.getQueue('render').counts.completed === 3 && worker.activeCount === 0)

  assert.deepEqual(started, ['high', 'first', 'last'])
  assert.equal(worker.activeCount, 0)
  assert.equal(runtime.queue.getJobs({ queueName: 'render', limit: 10 }).length, 3)
  assert.equal(jobs.length, 3)
})

test('moves due delayed jobs into the waiting state before they are claimed', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const job = await runtime.queue.add('scheduled', { run: true }, { delayMs: 10 })
  assert.equal(runtime.queue.getJob(job.id).state, 'delayed')
  await new Promise(resolve => setTimeout(resolve, 25))

  assert.equal(await runtime.queue.promoteDue('scheduled'), 1)
  assert.equal(runtime.queue.getJob(job.id).state, 'waiting')
  assert.equal(runtime.queue.getQueue('scheduled').counts.delayed, 0)
  assert.equal(runtime.queue.getQueue('scheduled').counts.waiting, 1)
})

test('retries with backoff and completes after the configured attempt count', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const job = await runtime.queue.add('retry-me', { value: 4 }, {
    attempts: 2,
    backoff: { type: 'fixed', delayMs: 20 }
  })
  let calls = 0
  const worker = runtime.queue.process('retry-me', async () => {
    calls++
    if (calls === 1) throw new Error('transient failure')
    return { stored: true }
  }, { pollingIntervalMs: 10, leaseDurationMs: 1_000 })
  await worker.start()
  await waitFor(() => runtime.queue.getJob(job.id).state === 'completed')

  const completed = runtime.queue.getJob(job.id)
  assert.equal(calls, 2)
  assert.equal(completed.attemptsMade, 2)
  assert.deepEqual(completed.returnValue, { stored: true })
  assert.equal(completed.lastError, undefined)
  assert.equal(runtime.queue.getQueue('retry-me').counts.delayed, 0)
})

test('expired leases are retried and old fencing tokens cannot settle reclaimed jobs', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const job = await runtime.queue.add('lease', { value: 1 }, {
    attempts: 2,
    backoff: { type: 'fixed', delayMs: 0 }
  })
  const first = runtime.queue.claimReady('lease', 'worker-old', 1, 20)[0]
  assert.ok(first)
  await runtime.db.flush()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(await runtime.queue.renewLease(job.id, first.token, 1_000), false)
  assert.equal(await runtime.queue.completeClaim(job.id, first.token, { stale: true }), false)
  assert.equal(await runtime.queue.recoverExpired('lease', 10), 1)
  const second = runtime.queue.claimReady('lease', 'worker-new', 1, 1_000)[0]
  assert.ok(second)

  assert.equal(await runtime.queue.completeClaim(job.id, first.token, { stale: true }), false)
  assert.equal(await runtime.queue.completeClaim(job.id, second.token, { fresh: true }), true)
  assert.deepEqual(runtime.queue.getJob(job.id).returnValue, { fresh: true })
  assert.equal(runtime.queue.getJob(job.id).attemptsMade, 2)
})

test('paused queues stop claims and resume without restarting the worker', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const job = await runtime.queue.add('paused', { value: 1 })
  await runtime.queue.pause('paused')
  const worker = runtime.queue.process('paused', async () => {}, { pollingIntervalMs: 10 })
  await worker.start()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(runtime.queue.getJob(job.id).state, 'waiting')

  await runtime.queue.resume('paused')
  await waitFor(() => runtime.queue.getJob(job.id).state === 'completed')
})

test('cancellation aborts an active handler and prevents a late completion', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const job = await runtime.queue.add('cancel', { value: 1 })
  let handlerAborted = false
  let markHandlerStarted
  const handlerStarted = new Promise(resolve => { markHandlerStarted = resolve })
  const worker = runtime.queue.process('cancel', async (_job, { signal }) => {
    markHandlerStarted()
    await new Promise(resolve => {
      signal.addEventListener('abort', () => { handlerAborted = true; resolve() }, { once: true })
    })
  }, { pollingIntervalMs: 10 })
  await worker.start()
  await waitFor(() => runtime.queue.getJob(job.id).state === 'active')
  await handlerStarted
  assert.equal(await runtime.queue.cancel(job.id), true)
  await waitFor(() => worker.activeCount === 0)

  assert.equal(handlerAborted, true)
  assert.equal(runtime.queue.getJob(job.id).state, 'cancelled')
})

test('waiting-only cancellation never aborts a claimed job', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const waiting = await runtime.queue.add('cancel-waiting-only', { value: 'waiting' })
  assert.equal(await runtime.queue.cancelWaiting(waiting.id), true)
  assert.equal(runtime.queue.getJob(waiting.id).state, 'cancelled')

  const active = await runtime.queue.add('cancel-waiting-only', { value: 'active' })
  let handlerAborted = false
  let markHandlerStarted
  const handlerStarted = new Promise(resolve => { markHandlerStarted = resolve })
  const worker = runtime.queue.process('cancel-waiting-only', async (_job, { signal }) => {
    markHandlerStarted()
    await new Promise(resolve => signal.addEventListener('abort', () => { handlerAborted = true; resolve() }, { once: true }))
  }, { pollingIntervalMs: 10 })
  await worker.start()
  await waitFor(() => runtime.queue.getJob(active.id).state === 'active')
  await handlerStarted
  assert.equal(await runtime.queue.cancelWaiting(active.id), false)
  assert.equal(runtime.queue.getJob(active.id).state, 'active')
  assert.equal(handlerAborted, false)

  assert.equal(await runtime.queue.cancel(active.id), true)
  await waitFor(() => worker.activeCount === 0)
  assert.equal(runtime.queue.getJob(active.id).state, 'cancelled')
})

test('worker drain keeps an active job lease renewed until its handler finishes', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const job = await runtime.queue.add('drain', { value: 1 })
  let markHandlerStarted
  const handlerStarted = new Promise(resolve => { markHandlerStarted = resolve })
  const worker = runtime.queue.process('drain', async () => {
    markHandlerStarted()
    await new Promise(resolve => setTimeout(resolve, 900))
  }, { pollingIntervalMs: 10, leaseDurationMs: 500 })
  await worker.start()
  await waitFor(() => runtime.queue.getJob(job.id).state === 'active')
  await handlerStarted

  await Promise.all([
    worker.stop({ drainTimeoutMs: 1_500 }),
    worker.stop({ drainTimeoutMs: 1_500 })
  ])

  assert.equal(runtime.queue.getJob(job.id).state, 'completed')
  assert.equal(worker.isRunning, false)
})

test('stored jobs survive a clean BroccoliDB restart and keep idempotency keys', async t => {
  const runtime = await createRuntime()
  const saved = await runtime.queue.add('persist', { value: 'kept' }, { idempotencyKey: 'stable-key' })
  await runtime.queue.close()
  await runtime.db.stop()

  const db = new BroccoliDatabaseKernel({ workspaceRoot: runtime.workspaceRoot })
  const queue = new BroccoliQueue({ db })
  await queue.start()
  t.after(async () => {
    await queue.close().catch(() => {})
    await db.stop().catch(() => {})
    await rm(runtime.workspaceRoot, { recursive: true, force: true })
  })

  assert.deepEqual(queue.getJob(saved.id).data, { value: 'kept' })
  assert.equal(queue.getQueue('persist').counts.waiting, 1)
  const duplicate = await queue.add('persist', { value: 'new' }, { idempotencyKey: 'stable-key' })
  assert.equal(duplicate.id, saved.id)
  assert.equal(queue.getJobs({ queueName: 'persist' }).length, 1)
})

test('dashboard serves the same queue instance and rejects unprotected network binding', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  await runtime.queue.addBulk([
    { name: 'dashboard', data: { secret: 'kept local' } },
    { name: 'dashboard', data: { secret: 'another local value' } }
  ])
  const dashboard = await runtime.queue.startDashboard({ port: 0 })
  t.after(() => dashboard.close())
  const response = await fetch(`${dashboard.address}/api/overview`)
  const overview = await response.json()
  assert.equal(response.status, 200)
  assert.equal(overview.totals.waiting, 2)
  const pageHtml = await fetch(dashboard.address)
  const page = await pageHtml.text()
  assert.match(page, /BroccoliQueue/)
  assert.match(pageHtml.headers.get('content-security-policy'), /script-src 'nonce-/)
  assert.match(page, /<script nonce="[^"]+">/)
  assert.match(page, /<style nonce="[^"]+">/)
  assert.match(page, /\[hidden\]\{display:none!important\}/)

  const invalidState = await fetch(`${dashboard.address}/api/jobs?state=unknown`)
  assert.equal(invalidState.status, 400)
  const unsupportedBodyType = await fetch(`${dashboard.address}/api/queues`, {
    method: 'POST',
    body: JSON.stringify({ name: 'wrong-content-type' })
  })
  assert.equal(unsupportedBodyType.status, 415)
  const dashboardPort = new URL(dashboard.address).port
  const reboundStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(new URL('/api/overview', dashboard.address), {
      headers: {
        host: `rebind.attacker.example:${dashboardPort}`,
        origin: `http://rebind.attacker.example:${dashboardPort}`
      }
    }, response => {
      response.resume()
      resolve(response.statusCode)
    })
    request.on('error', reject)
    request.end()
  })
  assert.equal(reboundStatus, 403)
  const oversized = await fetch(`${dashboard.address}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queueName: 'dashboard', data: 'x'.repeat(1_048_600) })
  })
  assert.equal(oversized.status, 413)
  assert.match((await oversized.json()).error, /exceeds 1 MiB/)
  const firstPage = await (await fetch(`${dashboard.address}/api/jobs?limit=1`)).json()
  const olderPage = await (await fetch(`${dashboard.address}/api/jobs?limit=1&before=${encodeURIComponent(firstPage.jobs[0].id)}`)).json()
  assert.equal(firstPage.jobs.length, 1)
  assert.equal(Object.hasOwn(firstPage.jobs[0], 'data'), false)
  assert.equal(olderPage.jobs.length, 1)
  assert.notEqual(firstPage.jobs[0].id, olderPage.jobs[0].id)
  const detail = await (await fetch(`${dashboard.address}/api/jobs/${firstPage.jobs[0].id}`)).json()
  assert.equal(Object.hasOwn(detail.job, 'data'), true)

  const firstQueue = await fetch(`${dashboard.address}/api/queues`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'created-once' })
  })
  const repeatedQueue = await fetch(`${dashboard.address}/api/queues`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'created-once' })
  })
  assert.equal((await firstQueue.json()).created, true)
  assert.equal((await repeatedQueue.json()).created, false)

  await assert.rejects(runtime.queue.startDashboard({ host: '0.0.0.0', port: 0 }), /authToken/)
  await assert.rejects(runtime.queue.startDashboard({
    host: '0.0.0.0',
    port: 0,
    authToken: 'r'.repeat(32)
  }), /TLS is required/)

  const protectedDashboard = await runtime.queue.startDashboard({ port: 0, authToken: 'local-dashboard-secret-123' })
  t.after(() => protectedDashboard.close())
  assert.equal((await fetch(`${protectedDashboard.address}/api/overview`)).status, 401)
  const authorized = await fetch(`${protectedDashboard.address}/api/overview`, {
    headers: { authorization: 'Bearer local-dashboard-secret-123' }
  })
  assert.equal(authorized.status, 200)
  const crossOrigin = await fetch(`${protectedDashboard.address}/api/queues`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer local-dashboard-secret-123',
      origin: 'https://attacker.example',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ name: 'cross-origin' })
  })
  assert.equal(crossOrigin.status, 403)
})

test('queue shutdown closes dashboards that it started', async t => {
  const runtime = await createRuntime()
  t.after(() => closeRuntime(runtime))
  const dashboard = await runtime.queue.startDashboard({ port: 0 })
  assert.equal(dashboard.server.listening, true)

  await runtime.queue.close()

  assert.equal(dashboard.server.listening, false)
  assert.equal(runtime.queue.getHealth().status, 'stopped')
})

test('retention removes terminal jobs in bounded batches', async t => {
  const runtime = await createRuntime({ retentionMs: 0 })
  t.after(() => closeRuntime(runtime))
  const job = await runtime.queue.add('retention', { value: 1 })
  const claim = runtime.queue.claimReady('retention', 'worker', 1, 1_000)[0]
  await runtime.db.flush()
  await runtime.queue.completeClaim(job.id, claim.token, null)

  assert.equal(await runtime.queue.prune({ batchSize: 1 }), 1)
  assert.equal(runtime.queue.getJob(job.id), null)
  assert.equal(runtime.queue.getQueue('retention').counts.completed, 0)
})

test('maxTerminalJobs retains only the newest terminal records', async t => {
  const runtime = await createRuntime({ retentionMs: 60_000, maxTerminalJobs: 2 })
  t.after(() => closeRuntime(runtime))
  const jobs = await runtime.queue.addBulk([0, 1, 2].map(value => ({ name: 'bounded', data: { value } })))
  const claims = runtime.queue.claimReady('bounded', 'worker', 3, 1_000)
  await runtime.db.flush()
  for (const [index, claim] of claims.entries()) {
    await runtime.queue.completeClaim(claim.job.id, claim.token, null)
    if (index < claims.length - 1) await new Promise(resolve => setTimeout(resolve, 3))
  }

  assert.equal(await runtime.queue.prune(), 1)
  assert.equal(runtime.queue.getJob(jobs[0].id), null)
  assert.equal(runtime.queue.getQueue('bounded').counts.completed, 2)
})

test('automatic retention catches up through multiple bounded batches', async t => {
  const runtime = await createRuntime({
    retentionMs: 0,
    maintenanceIntervalMs: 1_000,
    maintenanceBatchSize: 2,
    maintenanceMaxBatches: 5
  })
  t.after(() => closeRuntime(runtime))
  const jobs = await runtime.queue.addBulk(Array.from({ length: 7 }, (_, index) => ({
    name: 'maintenance', data: { index }
  })))
  const claims = runtime.queue.claimReady('maintenance', 'test-worker', jobs.length, 1_000)
  await runtime.db.flush()
  for (const claim of claims) await runtime.queue.completeClaim(claim.job.id, claim.token, null)

  await waitFor(() => runtime.queue.getQueue('maintenance').counts.completed === 0, 4_000)
  assert.equal(runtime.queue.getJobs({ queueName: 'maintenance', limit: 20 }).length, 0)
})
