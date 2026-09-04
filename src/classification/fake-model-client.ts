import type { Classification } from '../shared/types.js';
import type { ModelClient, ModelPrompt } from './model-client.js';
import { ModelTimeoutError } from './model-client.js';

/**
 * Deterministic fake model: classifies from content heuristics (not ticket IDs).
 * Returns raw JSON text — the application layer must validate before trusting.
 */
export class FakeModelClient implements ModelClient {
  constructor(private readonly latencyMs: number = 200) {}

  async generate(prompt: ModelPrompt, signal: AbortSignal): Promise<string> {
    await delay(this.latencyMs, signal);

    const text = extractTicketText(prompt.user);
    const classification = classifyFromContent(text);
    return JSON.stringify(classification);
  }
}

function extractTicketText(userPrompt: string): string {
  const subjectMatch = /<subject>([\s\S]*?)<\/subject>/.exec(userPrompt);
  const bodyMatch = /<body>([\s\S]*?)<\/body>/.exec(userPrompt);
  const subject = unescapeXml(subjectMatch?.[1] ?? '');
  const body = unescapeXml(bodyMatch?.[1] ?? '');
  return `${subject}\n${body}`.toLowerCase();
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function classifyFromContent(text: string): Classification {
  const deferredBilling = /separate ticket/.test(text) && /overcharg|refund|billing/.test(text);

  if (
    /download.*invoice|where do i download.*invoice|invoices/.test(text) &&
    !/data export/.test(text)
  ) {
    return {
      category: 'billing',
      priority: 'low',
      summary: 'The customer wants to know where invoices can be downloaded.',
    };
  }

  if (/data export|zip file/.test(text)) {
    return {
      category: 'technical',
      priority: 'medium',
      summary: 'The customer received an empty data export archive.',
    };
  }

  if (!deferredBilling && /charged twice|refund|overcharg|card statement|subscription/.test(text)) {
    if (/charged twice|refund|overcharg/.test(text)) {
      return {
        category: 'billing',
        priority: 'high',
        summary: 'The customer reports a duplicate charge and requests a refund.',
      };
    }
  }

  if (/wrong company name|invoice shows/.test(text)) {
    return {
      category: 'billing',
      priority: 'medium',
      summary: 'The customer needs a corrected invoice with the updated company name.',
    };
  }

  if (
    /invoice|invoices|charged|refund|subscription|overcharg|billing|payment|card statement/.test(
      text,
    ) &&
    !deferredBilling
  ) {
    return {
      category: 'billing',
      priority: 'medium',
      summary: 'The customer has a billing-related question.',
    };
  }

  if (
    /cannot log in|password|login|credentials|email address on my account|change the email|account/.test(
      text,
    )
  ) {
    if (/cannot log in|password|login|credentials/.test(text)) {
      return {
        category: 'account',
        priority: 'high',
        summary: 'The customer cannot log in after resetting their password.',
      };
    }
    return {
      category: 'account',
      priority: 'medium',
      summary: 'The customer wants to update their account email address.',
    };
  }

  if (/api|http 500|500s|error code|timeout|upload|integration|broken|e_timeout/.test(text)) {
    if (/500|blocking|production/.test(text)) {
      return {
        category: 'technical',
        priority: 'high',
        summary: 'The customer reports production API errors blocking a nightly job.',
      };
    }
    if (/e_timeout|upload/.test(text)) {
      return {
        category: 'technical',
        priority: 'high',
        summary: 'The customer still sees upload timeouts for large files.',
      };
    }
    return {
      category: 'technical',
      priority: 'medium',
      summary: 'The customer reports a technical issue with the product.',
    };
  }

  if (/dark mode|feature request|nice to have/.test(text)) {
    return {
      category: 'other',
      priority: 'low',
      summary: 'The customer requests a dark mode feature for the dashboard.',
    };
  }

  if (
    text.trim().length < 10 ||
    (/^[\s\S]*asdf[\s\S]*$/.test(text.trim()) && text.trim().length < 20)
  ) {
    return {
      category: 'other',
      priority: 'low',
      summary: 'The ticket lacks enough detail to identify a specific support issue.',
    };
  }

  return {
    category: 'other',
    priority: 'low',
    summary: 'The customer submitted a general support request.',
  };
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal.aborted) {
      throw new ModelTimeoutError('Model call aborted');
    }
    return;
  }

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
