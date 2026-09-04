import type { Classification, ModelFailureCode } from '../shared/types.js';
import { parseClassificationOutput, InvalidModelOutputError } from './classification-output.js';
import type { ModelClient } from './model-client.js';
import { ModelTimeoutError, ModelUnavailableError } from './model-client.js';
import { buildClassificationPrompt } from './prompt-builder.js';

export type ClassificationResult =
  | { ok: true; classification: Classification }
  | { ok: false; kind: 'failure'; code: ModelFailureCode }
  | { ok: false; kind: 'cancelled' };

/**
 * Application-layer classification pipeline:
 * 1) build prompt  2) call unreliable model  3) parse JSON
 * 4) strict-validate  5) return trusted domain object only after validation
 *
 * Hard deadline: race the model promise so an AbortSignal-ignoring provider
 * cannot hang a worker slot. Parent (shutdown) cancellation is distinct from
 * MODEL_TIMEOUT and must not be treated as a model failure.
 */
export class ClassificationService {
  constructor(
    private readonly model: ModelClient,
    private readonly modelTimeoutMs: number,
  ) {}

  async classify(
    ticket: { subject: string; body: string },
    parentSignal?: AbortSignal,
  ): Promise<ClassificationResult> {
    if (parentSignal?.aborted) {
      return { ok: false, kind: 'cancelled' };
    }

    const prompt = buildClassificationPrompt(ticket);
    const controller = new AbortController();
    let timedOut = false;
    let cancelledByParent = false;

    const onParentAbort = () => {
      cancelledByParent = true;
      controller.abort();
    };
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const generatePromise = this.model.generate(prompt, controller.signal);
      // Losing branch must not become an unhandled rejection.
      void generatePromise.catch(() => undefined);

      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new ModelTimeoutError());
        }, this.modelTimeoutMs);
      });

      const cancelPromise = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) {
          reject(new ModelTimeoutError('Model call aborted'));
          return;
        }
        controller.signal.addEventListener(
          'abort',
          () => reject(new ModelTimeoutError('Model call aborted')),
          { once: true },
        );
      });

      const raw = await Promise.race([generatePromise, timeoutPromise, cancelPromise]);

      try {
        const classification = parseClassificationOutput(raw);
        return { ok: true, classification };
      } catch (error) {
        if (error instanceof InvalidModelOutputError) {
          return { ok: false, kind: 'failure', code: 'INVALID_MODEL_OUTPUT' };
        }
        throw error;
      }
    } catch (error) {
      if (cancelledByParent || parentSignal?.aborted) {
        return { ok: false, kind: 'cancelled' };
      }
      if (error instanceof ModelTimeoutError || timedOut) {
        return { ok: false, kind: 'failure', code: 'MODEL_TIMEOUT' };
      }
      if (error instanceof ModelUnavailableError) {
        return { ok: false, kind: 'failure', code: 'MODEL_UNAVAILABLE' };
      }
      return { ok: false, kind: 'failure', code: 'MODEL_UNAVAILABLE' };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  }
}
