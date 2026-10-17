import type { SigninRateLimitOptions, SignupRateLimitOptions } from './auth.types.js';

export type DatabaseCheck = () => Promise<void>;

export interface AppOptions {
  signupRateLimit?: SignupRateLimitOptions;
  signinRateLimit?: SigninRateLimitOptions;
}
