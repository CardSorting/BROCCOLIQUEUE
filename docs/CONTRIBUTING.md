# Contributing

Contributions should keep queue ownership, persistence boundaries, and failure behavior easy to inspect. BroccoliQueue is licensed under MIT; preserve the repository's license and identify third-party material before adding it.

## Source map

| Area | Location |
|---|---|
| Public exports | `src/index.ts` |
| Job and option contracts | `src/types.ts` |
| Queue, scheduling, and workers | `src/queue.ts` |
| Dashboard HTTP security and routes | `src/dashboard.ts` |
| Dashboard interface | `dashboard/index.html` |
| Tests | `test/queue.test.js` |
| Synthetic benchmark | `bench/throughput.js` |
| Documentation | `README.md`, `docs/`, `docs/adr/` |

## Development workflow

```bash
npm install
npm run build
npm test
npm run docs:check
npm run bench -- --jobs 100000 --batch-size 500 --concurrency 16
```

Use the smallest relevant regression test while iterating, then run `npm test` and `npm run docs:check` before handoff. Tests should use temporary workspace roots and close queues and databases in cleanup paths.

## Contract rules

1. Preserve the public ESM entry point and Node.js `>=22.12.0` support.
2. Treat stored job fields, state transitions, idempotency, retry timing, and retention as compatibility-sensitive behavior.
3. Keep payload validation ahead of the first bulk mutation.
4. Never run application handlers before their claim batch has crossed the BroccoliDB flush boundary.
5. Keep handler I/O outside synchronous table read/modify/write operations.
6. Preserve the one-process-per-workspace boundary. New multi-process behavior needs a different coordination design and an ADR.
7. Keep dashboard payload exposure, Origin/Host validation, TLS, token requirements, and request limits explicit.
8. Benchmark changes with a named workload and environment. Do not turn one local observation into a throughput promise.

## Documentation rules

Update the relevant layer when behavior changes:

| Change | Required documentation |
|---|---|
| Export, signature, option default, or validation limit | [API reference](API.md) and package README |
| State transition, lease, delivery, or retry behavior | [Architecture](architecture.md), [API reference](API.md), and [Troubleshooting](TROUBLESHOOTING.md) |
| Startup, shutdown, persistence, backup, or retention behavior | [Operations](operations.md) and [Troubleshooting](TROUBLESHOOTING.md) |
| Dashboard access or action behavior | [Operations](operations.md#dashboard-exposure) and [Hardening review](hardening-review.md) |
| Stable architectural trade-off | An ADR under [`docs/adr/`](adr/README.md) |
| Performance number or supported runtime | README, [performance baseline](performance.md), and [docs map](README.md) |

Use the implementation and regression tests as evidence. Mark synthetic or illustrative values clearly. Examples should use public imports and show worker startup plus host-owned database shutdown.

## Pull request checklist

- [ ] Public exports and option defaults are intentional.
- [ ] Enqueue and claim paths preserve flush-before-success behavior.
- [ ] Retry, lease recovery, cancellation, and shutdown cases have regression coverage.
- [ ] Dashboard requests preserve authentication, origin/host checks, and payload bounds.
- [ ] README/API/operations/troubleshooting/ADR content matches the implementation.
- [ ] `npm test` and `npm run docs:check` pass.
- [ ] No generated build output, runtime state, credentials, or customer payloads were added accidentally.
