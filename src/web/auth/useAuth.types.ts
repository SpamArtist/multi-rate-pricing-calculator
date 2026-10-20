import type { User } from '../../shared/types/api-contracts.js';

export type RegistrationValues = { email: string; password: string };

export type AuthMode = 'sign-in' | 'sign-up';

export type AuthOperation = AuthMode | 'sign-out';

export type AuthSession = { user: User | null; generation: number };
