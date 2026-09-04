import { z } from 'zod';
import {
  CATEGORIES,
  MAX_SUMMARY_LENGTH,
  PRIORITIES,
  type Classification,
} from '../shared/types.js';

/**
 * Strict classification output schema.
 *
 * Summary rules (documented):
 * - Exact keys only; no coercion
 * - Trimmed, non-empty, single line, <= 240 characters
 * - Exactly one meaningful sentence (see isSingleSentenceSummary)
 * - No Markdown fences
 * - No silent repair or truncation
 *
 * Sentence detection (hybrid, because Intl.Segmenter alone is incomplete for EN):
 * 1. Prefer Intl.Segmenter('en', { granularity: 'sentence' }).
 * 2. Merge adjacent segments when the prior segment ends in a known abbreviation
 *    (Mr./Mrs./Ms./Dr./Prof./Sr./Jr./Inc./Ltd./Co./Corp./vs./etc.).
 * 3. Reject terminator + whitespace + lowercase letter (Segmenter keeps these as one
 *    segment, e.g. "First issue. second issue.").
 * 4. Reject terminator immediately followed by an uppercase letter with no space
 *    (e.g. "First.Second"), which Segmenter may also miss.
 * 5. A short declarative phrase without trailing punctuation is one segment.
 */
export const classificationOutputSchema = z
  .object({
    category: z.enum(CATEGORIES),
    priority: z.enum(PRIORITIES),
    summary: z.string(),
  })
  .strict();

export class InvalidModelOutputError extends Error {
  readonly code = 'INVALID_MODEL_OUTPUT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidModelOutputError';
  }
}

const KNOWN_ABBREVIATION_END =
  /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|Inc|Ltd|Co|Corp|vs|etc|a\.m|p\.m|U\.S|u\.s)\.\s*$/i;

/** Mask tokens that contain periods so sentence heuristics do not false-positive. */
function maskAbbreviationPeriods(summary: string): string {
  return summary
    .replaceAll('.NET', 'DOTNET')
    .replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|Inc|Ltd|Co|Corp|vs|etc)\./gi, 'ABBR')
    .replace(/\b(?:a\.m|p\.m|U\.S|u\.s)\./gi, 'ABBR');
}

function shouldMergeSegments(prev: string, next: string): boolean {
  if (KNOWN_ABBREVIATION_END.test(prev)) {
    return true;
  }
  // Intl.Segmenter splits ".NET" into "." + "NET …"
  const nextTrimmed = next.replace(/^\s+/, '');
  if (/\.\s*$/.test(prev) && /^NET\b/.test(nextTrimmed)) {
    return true;
  }
  return false;
}

function segmentWithIntl(summary: string): string[] {
  const SegmenterCtor = (
    Intl as unknown as {
      Segmenter?: new (
        locale: string,
        options: { granularity: 'sentence' },
      ) => { segment: (input: string) => Iterable<{ segment: string }> };
    }
  ).Segmenter;

  if (!SegmenterCtor) {
    return [summary];
  }

  const segmenter = new SegmenterCtor('en', { granularity: 'sentence' });
  const raw: string[] = [];
  for (const part of segmenter.segment(summary)) {
    if (part.segment.trim().length > 0) {
      raw.push(part.segment);
    }
  }

  const merged: string[] = [];
  for (const part of raw) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && shouldMergeSegments(prev, part)) {
      merged[merged.length - 1] = prev + part;
    } else {
      merged.push(part);
    }
  }
  return merged;
}

function countSentenceSegments(summary: string): number {
  const masked = maskAbbreviationPeriods(summary);
  // Segmenter gaps: lowercase continuation after a terminator.
  if (/[.!?]\s+[a-z]/.test(masked)) {
    return 2;
  }
  // Glued sentences ("First.Second") — require a letter before the terminator so
  // tokens like ".NET" are not treated as a sentence boundary.
  if (/[a-z][.!?][A-Z]/.test(masked)) {
    return 2;
  }

  return segmentWithIntl(summary).length;
}

function isSingleSentenceSummary(summary: string): boolean {
  if (summary.includes('\n') || summary.includes('\r')) {
    return false;
  }
  if (summary.includes('```')) {
    return false;
  }
  return countSentenceSegments(summary) === 1;
}

export function parseClassificationOutput(rawText: string): Classification {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new InvalidModelOutputError('Empty model output');
  }

  if (trimmed.startsWith('```') || !trimmed.startsWith('{')) {
    throw new InvalidModelOutputError('Model output is not bare JSON object');
  }
  if (!trimmed.endsWith('}')) {
    throw new InvalidModelOutputError('Model output is not bare JSON object');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new InvalidModelOutputError('Malformed JSON');
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new InvalidModelOutputError('JSON root must be an object');
  }

  const result = classificationOutputSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidModelOutputError('Schema validation failed');
  }

  const summary = result.data.summary.trim();
  if (summary.length === 0) {
    throw new InvalidModelOutputError('Summary is empty');
  }
  if (summary.length > MAX_SUMMARY_LENGTH) {
    throw new InvalidModelOutputError('Summary exceeds maximum length');
  }
  if (summary !== result.data.summary) {
    throw new InvalidModelOutputError('Summary has leading/trailing whitespace');
  }
  if (!isSingleSentenceSummary(summary)) {
    throw new InvalidModelOutputError('Summary must be a single concise sentence');
  }

  return {
    category: result.data.category,
    priority: result.data.priority,
    summary,
  };
}
