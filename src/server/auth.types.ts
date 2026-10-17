import type { Request, RequestHandler } from 'express';
import type { AuthenticatedOwnerId } from '../shared/types/authenticated-owner.js';

export interface SignupRateLimitOptions {
  maxRequests?: number;
  windowMs?: number;
}

export type SigninRateLimitOptions = SignupRateLimitOptions;

export interface AuthenticatedUser {
  id: AuthenticatedOwnerId;
  email: string;
}

export type AuthenticatedHandler = RequestHandler<
  Request['params'], unknown, unknown, Request['query'], { ownerId: AuthenticatedOwnerId }
>;

export type AuthenticatedResponse = Parameters<AuthenticatedHandler>[1];
