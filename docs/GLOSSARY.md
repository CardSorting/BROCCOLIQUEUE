# Glossary

| Term | Meaning |
|---|---|
| **Queue** | A named stream of jobs with persisted pause state and per-queue default options. |
| **Job** | A JSON-compatible payload and its state, attempt, timing, worker, and result metadata. |
| **Worker** | A handler registered for one queue name that claims jobs with bounded concurrency. |
| **Waiting** | Eligible for a worker to claim. |
| **Delayed** | Not eligible until `availableAt`; used for scheduled jobs and retry backoff. |
| **Active** | Claimed by a worker and protected by a renewable lease. |
| **Terminal state** | `completed`, `failed`, or `cancelled`; eligible for retention cleanup after its retention window. |
| **Attempt** | One handler execution. `maxAttempts` includes the first execution. |
| **Backoff** | Delay between retry attempts; supported strategies are fixed and exponential. |
| **Lease** | Expiring ownership assigned when a worker claims an active job. |
| **Heartbeat** | A lease renewal performed automatically by the worker or explicitly through `heartbeat()`. |
| **Fencing token** | Unpredictable claim token checked on renewal and settlement so an expired worker cannot overwrite a later claim. |
| **At-least-once delivery** | A job may run again when completion is uncertain or a lease expires; external effects must be idempotent. |
| **Idempotency key** | Stable producer key that returns the existing job for the same queue and namespace while its record remains. |
| **WAL flush** | BroccoliDB persistence barrier awaited before enqueue, claim, heartbeat, and settlement operations report success. |
| **Namespace** | Prefix for the queue's BroccoliDB jobs, queues, and metadata tables. |
| **Retention** | Time terminal job records remain before bounded automatic or manual pruning. |
| **Queue pause** | Persisted control that prevents new claims while allowing active handlers to continue. |
| **Worker pause** | Local control that pauses one worker handle without changing the queue's stored pause state. |
| **Health report** | `starting`, `healthy`, `degraded`, `closing`, or `stopped`; `degraded` records a persistence flush failure. |
| **Recent inspection window** | Latest 12,000 jobs retained in memory for `getJobs()` paging and dashboard browsing. |
| **BroccoliDB workspace** | The host-chosen filesystem root under which BroccoliDB stores `.broccolidb/` state. |
