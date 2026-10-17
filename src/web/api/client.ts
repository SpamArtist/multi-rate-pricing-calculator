import type { ApiError } from '../../shared/types/api-contracts.js';

export async function responseError(response: Response): Promise<ApiError> {
  try {
    const result = await response.json() as { error?: ApiError };
    return result.error ?? {};
  } catch {
    return {};
  }
}
