import { containsControlCharacters } from './text-validation.js';

export const EMAIL_ERROR = 'Enter a valid email address.';
export const PASSWORD_ERROR = 'Use 6 to 10 Unicode code points with no internal whitespace.';

export interface RegistrationValidation {
  emailDisplay: string;
  emailCanonical: string;
  password: string;
  fields: Record<string, string>;
}

export function trimUnicodeWhitespace(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

export function validateRegistrationFields(emailValue: unknown, passwordValue: unknown): RegistrationValidation {
  const fields = Object.create(null) as Record<string, string>;
  let emailDisplay = '';
  if (typeof emailValue !== 'string') {
    fields.email = EMAIL_ERROR;
  } else {
    emailDisplay = trimUnicodeWhitespace(emailValue);
    if (emailDisplay.length > 254 || containsControlCharacters(emailDisplay) || !/^[^\p{White_Space}@]+@[^\p{White_Space}@]+\.[^\p{White_Space}@]+$/u.test(emailDisplay)) {
      fields.email = EMAIL_ERROR;
    }
  }

  let password = '';
  if (typeof passwordValue !== 'string') {
    fields.password = PASSWORD_ERROR;
  } else {
    password = trimUnicodeWhitespace(passwordValue);
    const codePointLength = Array.from(password).length;
    if (codePointLength < 6 || codePointLength > 10 || containsControlCharacters(password) || /\p{White_Space}/u.test(password)) {
      fields.password = PASSWORD_ERROR;
    }
  }

  return {
    emailDisplay,
    emailCanonical: emailDisplay.toLowerCase(),
    password,
    fields,
  };
}
