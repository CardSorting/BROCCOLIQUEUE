import { EventEmitter } from 'node:events';
import type { AddJob, BroccoliDatabase, DashboardOptions, Job, JobOptions, JobQuery, JsonValue, QueueOptions, QueueHealth, QueueStateCounts, QueueSummary, RetryResult, WorkerContext, WorkerHandle, WorkerOptions } from './types.js';
interface StoredJob extends Record<string, unknown>, Job<JsonValue, JsonValue> {
    lockToken?: string;
    sequence: number;
}
interface ClaimedJob {
    job: StoredJob;
    token: string;
}
export type JobProcessor<T = JsonValue, R = JsonValue> = (job: Job<T>, context: WorkerContext) => R | Promise<R>;
/**
 * A BroccoliDB-backed queue. The database kernel is supplied by the host and
 * remains host-owned; queue.close() drains workers and flushes it but does not
 * stop the kernel.
 */
export declare class BroccoliQueue extends EventEmitter {
    #private;
    readonly namespace: string;
    readonly db: BroccoliDatabase;
    readonly defaultJobOptions: JobOptions;
    constructor(options: QueueOptions);
    get isStarted(): boolean;
    getHealth(): QueueHealth;
    start(): Promise<this>;
    /** Add one job. A successful return means the job's WAL frames were flushed. */
    add<T = JsonValue>(name: string, data: T, options?: JobOptions): Promise<Job<T>>;
    /** Add a producer batch and flush its WAL frames once. */
    addBulk<T = JsonValue>(items: readonly AddJob<T>[]): Promise<Job<T>[]>;
    /** Create a queue or return its existing configuration. */
    createQueue(name: string, options?: {
        paused?: boolean;
        defaultJobOptions?: JobOptions;
    }): Promise<QueueSummary>;
    /** Register a worker; call handle.start() to begin claiming jobs. */
    process<T = JsonValue, R = JsonValue>(name: string, processor: JobProcessor<T, R>, options?: WorkerOptions): WorkerHandle;
    getJob<T = JsonValue, R = JsonValue>(id: string): Job<T, R> | null;
    getJobs<T = JsonValue>(query?: JobQuery): Job<T>[];
    getQueues(): QueueSummary[];
    getWorkers(): Array<{
        id: string;
        queueName: string;
        activeCount: number;
        concurrency: number;
        isRunning: boolean;
    }>;
    getOverview(): {
        startedAt: number;
        health: QueueHealth;
        queues: QueueSummary[];
        workers: {
            id: string;
            queueName: string;
            activeCount: number;
            concurrency: number;
            isRunning: boolean;
        }[];
        totals: QueueStateCounts;
    };
    getQueue(name: string): QueueSummary | null;
    pause(name: string): Promise<boolean>;
    resume(name: string): Promise<boolean>;
    retry(id: string, options?: {
        delayMs?: number;
    }): Promise<RetryResult>;
    cancel(id: string): Promise<boolean>;
    /** Cancel only work that has not been claimed by a worker. */
    cancelWaiting(id: string): Promise<boolean>;
    delete(id: string): Promise<boolean>;
    /** Remove expired or over-cap terminal records in bounded batches. */
    prune(options?: {
        retentionMs?: number;
        batchSize?: number;
    }): Promise<number>;
    /** Start an authenticated, same-process monitoring and job-management dashboard. */
    startDashboard(options?: DashboardOptions): Promise<import("./types.js").DashboardHandle>;
    close(options?: {
        drainTimeoutMs?: number;
    }): Promise<void>;
    /** Internal worker boundary: persist a claim batch before starting handlers. */
    flushWrites(): Promise<void>;
    getWorkerOptions(name: string): JobOptions;
    ensureQueue(name: string): Promise<void>;
    isPaused(name: string): boolean;
    claimReady(name: string, workerId: string, limit: number, leaseDurationMs: number): ClaimedJob[];
    promoteDue(name: string): Promise<number>;
    recoverExpired(name: string, limit: number): Promise<number>;
    renewLease(id: string, token: string, leaseDurationMs: number): Promise<boolean>;
    completeClaim(id: string, token: string, result: unknown): Promise<boolean>;
    failClaim(id: string, token: string, error: unknown): Promise<boolean>;
    releaseClaim(id: string, token: string): Promise<void>;
    releaseClaims(claims: readonly {
        id: string;
        token: string;
    }[], options?: {
        restoreAttempts?: boolean;
    }): Promise<void>;
    registerController(id: string, controller: AbortController): void;
    unregisterController(id: string, controller: AbortController): void;
    registerWorker(worker: QueueWorker): void;
    unregisterWorker(worker: QueueWorker): void;
    reportWorkerError(error: unknown): void;
}
declare class QueueWorker implements WorkerHandle {
    #private;
    readonly id: string;
    readonly queueName: string;
    constructor(queue: BroccoliQueue, name: string, processor: JobProcessor, options: WorkerOptions);
    get isRunning(): boolean;
    get activeCount(): number;
    get concurrency(): number;
    start(): Promise<this>;
    pause(): void;
    resume(): void;
    wake(): void;
    stop(options?: {
        drainTimeoutMs?: number;
    }): Promise<void>;
}
export {};
