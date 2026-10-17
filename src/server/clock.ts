import type { Clock } from '../shared/types/clock.js';


export const systemClock: Clock = {
  now: () => new Date(),
};
