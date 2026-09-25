import type { BroccoliQueue } from './queue.js';
import type { DashboardHandle, DashboardOptions } from './types.js';
export declare function createDashboardServer(queue: BroccoliQueue, options?: DashboardOptions): Promise<DashboardHandle>;
