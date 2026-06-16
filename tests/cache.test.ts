import { describe, expect, it } from 'vitest';
import { buildTranslationCacheKey } from '../server/translation';
import type { TranscriptSegment } from '../shared/types';

const baseSegments: TranscriptSegment[] = [
  {
    id: 'a',
    startMs: 0,
    durationMs: 1000,
    text: 'Hello.'
  }
];

describe('buildTranslationCacheKey', () => {
  it('is stable for the same transcript payload', () => {
    const first = buildTranslationCacheKey({
      videoId: 'dQw4w9WgXcQ',
      sourceLang: 'en',
      targetLang: 'zh-CN',
      segments: baseSegments
    });
    const second = buildTranslationCacheKey({
      videoId: 'dQw4w9WgXcQ',
      sourceLang: 'en',
      targetLang: 'zh-CN',
      segments: baseSegments
    });

    expect(first).toBe(second);
  });

  it('changes when transcript text changes', () => {
    const first = buildTranslationCacheKey({
      videoId: 'dQw4w9WgXcQ',
      sourceLang: 'en',
      targetLang: 'zh-CN',
      segments: baseSegments
    });
    const second = buildTranslationCacheKey({
      videoId: 'dQw4w9WgXcQ',
      sourceLang: 'en',
      targetLang: 'zh-CN',
      segments: [{ ...baseSegments[0], text: 'Changed.' }]
    });

    expect(first).not.toBe(second);
  });
});
