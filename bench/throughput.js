import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { BroccoliDatabaseKernel } from '@noorm/broccolidb'
import { BroccoliQueue } from '../dist/index.js'

function argumentsFrom (args) {
  const values = { jobs: 100_000, batchSize: 500, concurrency: 16, payloadBytes: 128, flushBatchDelayMs: 0 }
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (key === '--help') {
      console.log('Usage: npm run bench -- [--jobs N] [--batch-size N] [--concurrency N] [--payload-bytes N] [--flush-batch-delay-ms N]')
      process.exit(0)
    }
    const name = ({ '--jobs': 'jobs', '--batch-size': 'batchSize', '--concurrency': 'concurrency', '--payload-bytes': 'payloadBytes', '--flush-batch-delay-ms': 'flushBatchDelayMs' })[key]
    if (!name) throw new Error(`Unknown option: ${key}`)
    const value = Number(args[index + 1])
    const minimum = key === '--flush-batch-delay-ms' ? 0 : 1
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${key} must be a safe integer of at least ${minimum}`)
    values[name] = value
    index += 1
  }
  if (values.jobs > 1_000_000) throw new Error('--jobs is capped at 1,000,000 for this local benchmark')
  if (values.batchSize > 10_000) throw new Error('--batch-size is capped at 10,000')
  if (values.concurrency > 10_000) throw new Error('--concurrency is capped at 10,000')
  if (values.payloadBytes > 1_048_576) throw new Error('--payload-bytes is capped at 1 MiB')
  if (values.flushBatchDelayMs > 1_000) throw new Error('--flush-batch-delay-ms is capped at 1,000')
  return values
}

function percentile (values, fraction) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function waitForCompletion (queue, name, expected, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const timer = setInterval(() => {
      const completed = queue.getQueue(name)?.counts.completed ?? 0
      if (completed >= expected) {
        clearInterval(timer)
        resolve(performance.now() - started)
      } else if (performance.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`Timed out after completing ${completed}/${expected} jobs`))
      }
    }, 10)
  })
}

async function main () {
  const options = argumentsFrom(process.argv.slice(2))
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'broccoli-queue-bench-'))
  const db = new BroccoliDatabaseKernel({ workspaceRoot })
  const queue = new BroccoliQueue({ db, retentionMs: 0, flushBatchDelayMs: options.flushBatchDelayMs })
  let worker
  const start = performance.now()

  try {
    await queue.start()
    const startLatencies = []
    worker = queue.process('bench', async job => {
      startLatencies.push(performance.now() - job.data.enqueuedAt)
    }, { concurrency: options.concurrency, batchSize: Math.min(options.batchSize, 500) })
    await worker.start()

    const payload = 'x'.repeat(options.payloadBytes)
    const enqueueStarted = performance.now()
    for (let offset = 0; offset < options.jobs; offset += options.batchSize) {
      const count = Math.min(options.batchSize, options.jobs - offset)
      const enqueuedAt = performance.now()
      await queue.addBulk(Array.from({ length: count }, (_, itemIndex) => ({
        name: 'bench',
        data: { index: offset + itemIndex, enqueuedAt, payload }
      })))
    }
    const enqueueMs = performance.now() - enqueueStarted
    const drainMs = await waitForCompletion(queue, 'bench', options.jobs, 30 * 60_000)
    const elapsedMs = performance.now() - start
    const memory = process.memoryUsage()

    console.log(JSON.stringify({
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        logicalCpus: os.cpus().length
      },
      jobs: options.jobs,
      batchSize: options.batchSize,
      concurrency: options.concurrency,
      payloadBytes: options.payloadBytes,
      flushBatchDelayMs: options.flushBatchDelayMs,
      enqueueJobsPerSecond: Math.round(options.jobs / (enqueueMs / 1_000)),
      completionJobsPerSecond: Math.round(options.jobs / (drainMs / 1_000)),
      endToEndJobsPerSecond: Math.round(options.jobs / (elapsedMs / 1_000)),
      enqueueToStartMs: {
        p50: Number(percentile(startLatencies, 0.50).toFixed(2)),
        p95: Number(percentile(startLatencies, 0.95).toFixed(2)),
        max: Number(startLatencies.reduce((maximum, value) => Math.max(maximum, value), 0).toFixed(2))
      },
      elapsedMs: Math.round(elapsedMs),
      memoryMiB: {
        rss: Number((memory.rss / 1_048_576).toFixed(1)),
        heapUsed: Number((memory.heapUsed / 1_048_576).toFixed(1))
      }
    }))
  } finally {
    await worker?.stop({ drainTimeoutMs: 0 }).catch(() => {})
    await queue.close({ drainTimeoutMs: 0 }).catch(() => {})
    await db.stop().catch(() => {})
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
