import type { ApiError } from './contracts.js';

export async function responseError(response: Response): Promise<ApiError> {
  try {
    const result = await response.json() as { error?: ApiError };
    return result.error ?? {};
  } catch {
    return {};
  }
}
