export interface ApiSession {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export function createApiSession(): ApiSession {
  const cookies = new Map<string, string>();

  return {
    async fetch(input, init = {}) {
      const headers = new Headers(init.headers);
      if (cookies.size > 0 && !headers.has('cookie')) {
        headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
      }
      const response = await fetch(input, { ...init, headers });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';', 1);
        const separator = pair.indexOf('=');
        if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
      return response;
    },
  };
}
