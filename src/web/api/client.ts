import type { FieldErrors } from './contracts.js';

export async function responseError(response: Response): Promise<{ message?: string; fields?: FieldErrors }> {
  try {
    const result = await response.json() as { error?: { message?: string; fields?: FieldErrors } };
    return result.error ?? {};
  } catch {
    return {};
  }
}
