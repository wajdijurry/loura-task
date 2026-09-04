import { describe, expect, it } from 'vitest';
import {
  InvalidModelOutputError,
  parseClassificationOutput,
} from '../../src/classification/classification-output.js';

const valid = {
  category: 'billing',
  priority: 'low',
  summary: 'The customer wants to know where invoices can be downloaded.',
};

describe('parseClassificationOutput', () => {
  it('accepts valid model output', () => {
    const result = parseClassificationOutput(JSON.stringify(valid));
    expect(result).toEqual(valid);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseClassificationOutput('{not-json')).toThrow(InvalidModelOutputError);
  });

  it('rejects missing keys', () => {
    expect(() =>
      parseClassificationOutput(JSON.stringify({ category: 'billing', priority: 'low' })),
    ).toThrow(InvalidModelOutputError);
  });

  it('rejects extra keys', () => {
    expect(() => parseClassificationOutput(JSON.stringify({ ...valid, extra: true }))).toThrow(
      InvalidModelOutputError,
    );
  });

  it('rejects wrong types', () => {
    expect(() =>
      parseClassificationOutput(
        JSON.stringify({ category: 'billing', priority: 'low', summary: 12 }),
      ),
    ).toThrow(InvalidModelOutputError);
  });

  it('rejects invalid enums', () => {
    expect(() =>
      parseClassificationOutput(JSON.stringify({ ...valid, category: 'finance' })),
    ).toThrow(InvalidModelOutputError);
    expect(() =>
      parseClassificationOutput(JSON.stringify({ ...valid, priority: 'urgent' })),
    ).toThrow(InvalidModelOutputError);
  });

  it('rejects nulls and arrays', () => {
    expect(() => parseClassificationOutput('null')).toThrow(InvalidModelOutputError);
    expect(() => parseClassificationOutput('[]')).toThrow(InvalidModelOutputError);
  });

  it('rejects empty, whitespace, multi-line, multi-sentence, and overlong summaries', () => {
    expect(() => parseClassificationOutput(JSON.stringify({ ...valid, summary: '' }))).toThrow(
      InvalidModelOutputError,
    );
    expect(() =>
      parseClassificationOutput(JSON.stringify({ ...valid, summary: '  padded  ' })),
    ).toThrow(InvalidModelOutputError);
    expect(() =>
      parseClassificationOutput(JSON.stringify({ ...valid, summary: 'Line one.\nLine two.' })),
    ).toThrow(InvalidModelOutputError);
    expect(() =>
      parseClassificationOutput(
        JSON.stringify({ ...valid, summary: 'First issue. second issue.' }),
      ),
    ).toThrow(InvalidModelOutputError);
    expect(() =>
      parseClassificationOutput(
        JSON.stringify({ ...valid, summary: 'First sentence. Second sentence.' }),
      ),
    ).toThrow(InvalidModelOutputError);
    expect(() =>
      parseClassificationOutput(JSON.stringify({ ...valid, summary: 'A'.repeat(241) })),
    ).toThrow(InvalidModelOutputError);
  });

  it('accepts a single sentence containing a version number like v2.0', () => {
    const result = parseClassificationOutput(
      JSON.stringify({
        ...valid,
        summary: 'The customer reports a regression after upgrading to v2.0 of the SDK.',
      }),
    );
    expect(result.summary).toContain('v2.0');
  });

  it('accepts summaries with .NET, U.S., p.m., and Dr. abbreviations', () => {
    expect(
      parseClassificationOutput(
        JSON.stringify({
          ...valid,
          summary: 'The customer reports a bug in the .NET SDK after upgrade.',
        }),
      ).summary,
    ).toContain('.NET');

    expect(
      parseClassificationOutput(
        JSON.stringify({
          ...valid,
          summary: 'The customer lives in the U.S. and needs billing help.',
        }),
      ).summary,
    ).toContain('U.S.');

    expect(
      parseClassificationOutput(
        JSON.stringify({
          ...valid,
          summary: 'The customer called at 3 p.m. about a refund.',
        }),
      ).summary,
    ).toContain('p.m.');

    expect(
      parseClassificationOutput(
        JSON.stringify({
          ...valid,
          summary: 'The customer needs help with their Dr. Smith account billing.',
        }),
      ).summary,
    ).toContain('Dr.');
  });

  it('does not reject a normal abbreviation as a second sentence', () => {
    const result = parseClassificationOutput(
      JSON.stringify({
        ...valid,
        summary: 'The customer needs help with their Dr. Smith account billing.',
      }),
    );
    expect(result.summary).toContain('Dr.');
  });

  it('accepts a short one-sentence summary without trailing punctuation', () => {
    // Documented rule: a single declarative segment without a terminator is valid.
    const result = parseClassificationOutput(
      JSON.stringify({
        ...valid,
        summary: 'Customer requests invoice download instructions',
      }),
    );
    expect(result.summary).toBe('Customer requests invoice download instructions');
  });

  it('rejects Markdown fences and surrounding prose', () => {
    expect(() => parseClassificationOutput('```json\n' + JSON.stringify(valid) + '\n```')).toThrow(
      InvalidModelOutputError,
    );
    expect(() => parseClassificationOutput('Here you go: ' + JSON.stringify(valid))).toThrow(
      InvalidModelOutputError,
    );
  });

  it('does not coerce types', () => {
    expect(() =>
      parseClassificationOutput(
        JSON.stringify({ category: 'billing', priority: 'low', summary: true }),
      ),
    ).toThrow(InvalidModelOutputError);
  });
});
