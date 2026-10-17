import type { FieldErrors } from './field-errors.js';

export interface RegistrationValidation {
  emailDisplay: string;
  emailCanonical: string;
  password: string;
  fields: FieldErrors;
}
