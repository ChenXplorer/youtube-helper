import { describe, expect, it } from 'vitest';
import { applyTranslations, findCurrentSegmentIndex, normalizeTranscriptSegments } from '../shared/transcript';

describe('transcript helpers', () => {
  it('normalizes seconds and HTML entities into millisecond segments', () => {
    const segments = normalizeTranscriptSegments([
      { offset: 1.234, duration: 2.5, text: ' Wow &amp; nice ' },
      { offset: 4, duration: 0.1, text: '   ' }
    ]);

    expect(segments).toEqual([
      {
        id: 'seg-0-1234',
        startMs: 1234,
        durationMs: 2500,
        text: 'Wow & nice'
      }
    ]);
  });

  it('finds the latest segment at or before the current time', () => {
    const segments = normalizeTranscriptSegments([
      { offset: 0, duration: 1, text: 'first' },
      { offset: 3, duration: 1, text: 'second' }
    ]);

    expect(findCurrentSegmentIndex(segments, -1)).toBe(-1);
    expect(findCurrentSegmentIndex(segments, 0)).toBe(0);
    expect(findCurrentSegmentIndex(segments, 2500)).toBe(0);
    expect(findCurrentSegmentIndex(segments, 3000)).toBe(1);
  });

  it('applies translations by index', () => {
    const segments = normalizeTranscriptSegments([{ offset: 0, duration: 1, text: 'hello' }]);
    expect(applyTranslations(segments, ['你好'])[0].translation).toBe('你好');
  });

  it('merges fragmented captions into readable segments', () => {
    const segments = normalizeTranscriptSegments([
      { offset: 0, duration: 1, text: '[Music]' },
      { offset: 1, duration: 1, text: "So, I'm running Fable 5 inside of" },
      { offset: 2, duration: 1, text: "Cursor's agent window," },
      { offset: 3, duration: 1, text: 'as well as inside of Claude.' },
      { offset: 7, duration: 1, text: 'Next sentence starts here.' }
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe(
      "So, I'm running Fable 5 inside of Cursor's agent window, as well as inside of Claude."
    );
    expect(segments[0].startMs).toBe(1000);
    expect(segments[0].durationMs).toBe(3000);
    expect(segments[1].text).toBe('Next sentence starts here.');
  });

  it('splits multiple sentences inside one caption segment', () => {
    const segments = normalizeTranscriptSegments([
      { offset: 0, duration: 4, text: 'This is the first sentence. This is the second sentence.' }
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe('This is the first sentence.');
    expect(segments[1].text).toBe('This is the second sentence.');
    expect(segments[1].startMs).toBeGreaterThan(segments[0].startMs);
  });

  it('keeps a long unfinished sentence together until sentence punctuation', () => {
    const segments = normalizeTranscriptSegments([
      { offset: 0, duration: 1, text: 'This is a very long thought about model workflows that' },
      { offset: 1, duration: 1, text: 'continues across several generated caption slices and should' },
      { offset: 2, duration: 1, text: 'stay together instead of being cut off just because it is' },
      { offset: 3, duration: 1, text: 'a little longer than a normal subtitle line.' }
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe(
      'This is a very long thought about model workflows that continues across several generated caption slices and should stay together instead of being cut off just because it is a little longer than a normal subtitle line.'
    );
  });
});
