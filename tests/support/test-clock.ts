import type { Clock } from '../../src/server/clock.js';

export class TestClock implements Clock {
  private current: Date;

  constructor(initial: string | Date) {
    this.current = new Date(initial);
  }

  now(): Date {
    return new Date(this.current);
  }

  freeze(instant: string | Date): void {
    this.current = new Date(instant);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
