export type DuplicationBrowserStage =
  | 'invoked' | 'fetch.start' | 'response.headers' | 'body.parsed'
  | 'state.committed' | 'frame.boundary';

export type DuplicationBrowserRecord = {
  interaction: 'duplicate' | 'open-copy';
  requestId?: string;
  status?: number;
  outcome?: 'success' | 'error' | 'auth-expired';
  stages: Array<{ stage: DuplicationBrowserStage; elapsedMs: number }>;
};

export type DuplicationBrowserAction = {
  startedAt: number;
  record: DuplicationBrowserRecord;
};
