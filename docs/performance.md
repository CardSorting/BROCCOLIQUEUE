# Performance baseline

This is a local synthetic reference run, not a capacity promise. It measures 10,000 JSON jobs with a 128-byte string payload, producer batches of 250, no-op async handlers, and a 0 ms `flushBatchDelayMs` on a temporary local BroccoliDB workspace.

Environment: Node.js v24.16.0, macOS arm64, 10 logical CPUs.

| Worker concurrency | Enqueue jobs/s | Completion jobs/s | End-to-end jobs/s | p95 enqueue-to-start | Peak RSS |
|---:|---:|---:|---:|---:|---:|
| 16 | 27,701 | 1,206 | 1,153 | 7.90 s | 136.8 MiB |
| 64 | 26,580 | 4,875 | 4,092 | 1.95 s | 136.7 MiB |

These are single observations from the implementation machine. The synthetic handler has no external I/O or CPU work, and end-to-end latency includes filling the queue before it drains. Measure several runs with representative payloads, filesystem, durability settings, and handler work before choosing concurrency or declaring a service target.

Run the benchmark with a workload of your choice:

```bash
npm run bench -- --jobs 100000 --batch-size 500 --concurrency 64 --payload-bytes 128 --flush-batch-delay-ms 0
```

See [Capacity checks](operations.md#capacity-checks) for a measurement checklist and [Architecture](architecture.md#operational-costs) for the costs that affect results.
