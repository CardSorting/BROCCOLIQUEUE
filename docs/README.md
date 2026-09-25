# BroccoliQueue documentation

This is the documentation map for BroccoliQueue, a BroccoliDB-backed queue that runs in one Node.js process. The docs follow a layered path used by mature infrastructure projects:

**Concepts → How it works → Reference → Operations → Decisions**

The implementation and tests are authoritative when documentation disagrees. This map explains where a claim belongs and gives each reader a shortest useful path.

## Reading paths by role

| Role | Start here | Then read |
|---|---|---|
| **Application developer** | [Quick start](../README.md#quick-start) | [API reference](API.md) · [Operations](operations.md) |
| **Worker author** | [Delivery and retries](../README.md#delivery-and-retries) | [API reference](API.md#workers) · [Troubleshooting](TROUBLESHOOTING.md#worker-and-delivery) |
| **Operator / support** | [Operations](operations.md) | [Troubleshooting](TROUBLESHOOTING.md) · [Glossary](GLOSSARY.md) |
| **Architect / reviewer** | [Brief](BRIEF.md) | [Architecture](architecture.md) · [Philosophy](PHILOSOPHY.md) · [ADR-001](adr/ADR-001-process-local-at-least-once-queue.md) |
| **Security reviewer** | [Dashboard exposure](operations.md#dashboard-exposure) | [Hardening review](hardening-review.md) · [Architecture](architecture.md#durability-and-failures) |
| **Contributor** | [Contributing](CONTRIBUTING.md) | [Architecture](architecture.md) · [API reference](API.md) · [ADR process](adr/README.md) |
| **Performance investigator** | [Performance baseline](performance.md) | [Capacity checks](operations.md#capacity-checks) · [Architecture costs](architecture.md#operational-costs) |

## Document catalog

### Concepts — why

| Document | Purpose |
|---|---|
| [Brief](BRIEF.md) | Problem, solution, guarantees, product fit, and non-goals |
| [Philosophy](PHILOSOPHY.md) | Design principles, explicit trade-offs, and familiar reference patterns |
| [Glossary](GLOSSARY.md) | Canonical terms for claims, leases, retries, fencing, and delivery |

### How it works — what happens

| Document | Purpose |
|---|---|
| [Architecture](architecture.md) | Tables, scheduling indexes, state changes, worker claims, and recovery |
| [Hardening review](hardening-review.md) | Security, WAL, lifecycle, and bounded-work findings from the review pass |

### Reference — what to call

| Document | Purpose |
|---|---|
| [Package README](../README.md) | Install, quick start, lifecycle, boundaries, and command index |
| [API reference](API.md) | Public exports, queue methods, job options, worker options, and dashboard |
| [Package exports](../src/index.ts) | Export surface — the source of truth for package imports |
| [Contracts](../src/types.ts) | Type-level API and JSON-compatible job contracts |

### Operations — how to run and debug

| Document | Purpose |
|---|---|
| [Operations guide](operations.md) | Startup/shutdown, durability, backup, security, retention, and capacity |
| [Troubleshooting](TROUBLESHOOTING.md) | Symptom → likely cause → action runbooks |
| [Performance baseline](performance.md) | Synthetic local measurements and repeatable benchmark command |

### Decisions — why the shape is stable

| Document | Purpose |
|---|---|
| [ADR index](adr/README.md) | Decision inventory and writing rules |
| [ADR-001](adr/ADR-001-process-local-at-least-once-queue.md) | Why the queue is process-local and delivery is at least once |

## Documentation conventions

1. **Describe the current package.** Do not imply support for remote workers, cross-process coordination, SQL backends, cron scheduling, or workflow graphs.
2. **Name the delivery and durability boundary.** Distinguish enqueue acceptance, a completed BroccoliDB flush, handler completion, and the queue's at-least-once guarantee.
3. **Name the source of truth.** Public exports live in `src/index.ts`; contracts live in `src/types.ts`; implementation behavior is in `src/queue.ts` and `src/dashboard.ts`; tests live in `test/`.
4. **Keep examples executable.** Use the public package imports, JSON-compatible values, explicit worker startup, and orderly shutdown.
5. **Document failure boundaries.** Say which work is process-local, which state is in BroccoliDB, what retries, and what requires an external coordination system.
6. **Use stable vocabulary.** Say queue, job, worker, lease, fencing token, attempt, retry, retention, BroccoliDB workspace, and WAL consistently.
7. **Update docs with contracts.** Changes to public methods/options, delivery behavior, persistence boundaries, dashboard access, or package support require updates to the relevant docs and an ADR when they change a durable design decision.
8. **Label evidence.** Performance data must name its workload and environment; synthetic measurements are not service guarantees.

## Source-of-truth matrix

| Question | Source of truth |
|---|---|
| What can consumers import? | `src/index.ts` and generated `dist/index.d.ts` |
| What does a method accept or return? | `src/types.ts` and public class signatures |
| How are job records claimed and recovered? | `src/queue.ts` |
| How is the dashboard protected and routed? | `src/dashboard.ts` |
| Which behavior is protected by regression tests? | `test/queue.test.js` |
| What does a local benchmark measure? | `bench/throughput.js` and `docs/performance.md` |
| What enters the published package? | `package.json` and `npm pack --dry-run` |

## Status

| Metric | Current value |
|---|---|
| Package | `broccoli-queue@0.1.0` |
| API status | Early package line; review public contracts before depending on undocumented internals |
| Runtime | Node.js `>=22.12.0`; BroccoliDB peer dependency `^3.0.0` |
| Public entry point | `src/index.ts` / `dist/index.js` |
| Persistence | BroccoliDB tables and local WAL |
| Delivery | At least once |
| Coordination | One Node.js process per BroccoliDB workspace |
| License | MIT; BroccoliDB is separately licensed |

## Quick links

```bash
# Build and run the package tests
npm test

# Validate required docs and relative Markdown links
npm run docs:check

# Measure a synthetic local workload
npm run bench -- --jobs 100000 --batch-size 500 --concurrency 16
```
