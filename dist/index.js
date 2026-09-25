export { BroccoliQueue } from './queue.js';
export const states = Object.freeze({
    waiting: 'waiting',
    delayed: 'delayed',
    active: 'active',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'cancelled'
});
