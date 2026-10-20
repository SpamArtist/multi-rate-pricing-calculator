export interface ApiSession {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}
