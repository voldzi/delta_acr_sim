import type { EventEmitter } from 'node:events';
export function attachSimPgErrorObservers(pool: EventEmitter, lane: 'target' | 'guard'): void;
