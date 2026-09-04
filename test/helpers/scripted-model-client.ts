import type { ModelClient, ModelPrompt } from '../../src/classification/model-client.js';
import { ModelTimeoutError, ModelUnavailableError } from '../../src/classification/model-client.js';

/**
 * Test-only scripted model: predetermined outcomes for deterministic worker tests.
 */
export type ScriptedOutcome =
  | { type: 'text'; value: string }
  | { type: 'error'; error: Error }
  | { type: 'timeout'; delayMs?: number }
  | { type: 'hang' };

export class ScriptedModelClient implements ModelClient {
  private index = 0;
  private readonly callLog: ModelPrompt[] = [];

  constructor(private readonly outcomes: ScriptedOutcome[]) {}

  get calls(): readonly ModelPrompt[] {
    return this.callLog;
  }

  get callCount(): number {
    return this.callLog.length;
  }

  async generate(prompt: ModelPrompt, signal: AbortSignal): Promise<string> {
    this.callLog.push(prompt);
    const outcome = this.outcomes[this.index];
    this.index += 1;

    if (!outcome) {
      throw new ModelUnavailableError('Scripted model exhausted outcomes');
    }

    if (outcome.type === 'hang') {
      await new Promise<never>(() => undefined);
      throw new ModelUnavailableError('unreachable');
    }

    if (outcome.type === 'timeout') {
      const delayMs = outcome.delayMs ?? 50;
      await abortableDelay(delayMs, signal);
      throw new ModelTimeoutError();
    }

    if (outcome.type === 'error') {
      throw outcome.error;
    }

    if (signal.aborted) {
      throw new ModelTimeoutError('Model call aborted');
    }

    return outcome.value;
  }
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new ModelTimeoutError('Model call aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ModelTimeoutError('Model call aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
