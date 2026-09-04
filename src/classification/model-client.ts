export interface ModelPrompt {
  system: string;
  user: string;
}

export interface ModelClient {
  generate(prompt: ModelPrompt, signal: AbortSignal): Promise<string>;
}

export class ModelTimeoutError extends Error {
  readonly code = 'MODEL_TIMEOUT' as const;

  constructor(message = 'Model call timed out') {
    super(message);
    this.name = 'ModelTimeoutError';
  }
}

export class ModelUnavailableError extends Error {
  readonly code = 'MODEL_UNAVAILABLE' as const;

  constructor(message = 'Model provider unavailable') {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}
