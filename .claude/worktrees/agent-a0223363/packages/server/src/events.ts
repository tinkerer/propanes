import { EventEmitter } from 'node:events';

export const feedbackEvents = new EventEmitter();
feedbackEvents.setMaxListeners(50);
