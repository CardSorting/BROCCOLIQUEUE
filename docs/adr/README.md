# Architecture decisions

Architecture decision records (ADRs) capture design choices that affect queue contracts, stored data, deployment, or recovery. The implementation and tests remain authoritative for current behavior.

## Index

| ID | Decision | Status |
|---|---|---|
| [ADR-001](ADR-001-process-local-at-least-once-queue.md) | Keep BroccoliQueue process-local and make delivery at least once | Accepted |

## When to write an ADR

Write or update an ADR when a change affects:

- the process/workspace ownership model;
- job state, retry, lease, cancellation, or delivery guarantees;
- the BroccoliDB schema or compatibility behavior;
- dashboard security boundaries;
- a product-level trade-off unlikely to be clear from code alone.

Keep implementation details in the architecture/API/operations guides. An ADR records context, decision, consequences, and current status.

## Template

Copy [`TEMPLATE.md`](TEMPLATE.md) and choose a stable next ID. Accepted decisions should describe limits as well as benefits.
