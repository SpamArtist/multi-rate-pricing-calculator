import type { LinePricingInput } from './pricing.js';

export type DraftLineInput = LinePricingInput & { id?: string; description: string };
