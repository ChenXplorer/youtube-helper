import type { TranscriptSegment } from './types';

export type RawTranscriptSegment = {
  text: string;
  duration: number;
  offset: number;
};

export function normalizeTranscriptSegments(rawSegments: RawTranscriptSegment[]): TranscriptSegment[] {
  const normalizedSegments = rawSegments
    .map((segment, index) => {
      const startMs = Math.max(0, Math.round(segment.offset * 1000));
      const durationMs = Math.max(250, Math.round(segment.duration * 1000));
      const text = normalizeCaptionText(segment.text);

      return {
        id: `seg-${index}-${startMs}`,
        startMs,
        durationMs,
        text
      };
    })
    .filter((segment) => segment.text.length > 0 && !isNonSpeechCaption(segment.text));

  return organizeTranscriptSegments(normalizedSegments);
}

export function organizeTranscriptSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const sentencePieces = splitSegmentsIntoSentencePieces(segments);
  const organized: TranscriptSegment[] = [];
  let current: TranscriptSegment | null = null;

  for (const segment of sentencePieces) {
    if (current && shouldStartNewSegment(current, segment)) {
      organized.push(current);
      current = null;
    }

    if (!current) {
      current = { ...segment };
    } else {
      const activeSegment: TranscriptSegment = current;
      const endMs = Math.max(
        activeSegment.startMs + activeSegment.durationMs,
        segment.startMs + segment.durationMs
      );
      current = {
        ...activeSegment,
        durationMs: endMs - activeSegment.startMs,
        text: joinCaptionText(activeSegment.text, segment.text)
      };
    }

    if (current && shouldFinalizeSentence(current)) {
      organized.push(current);
      current = null;
    }
  }

  if (current) {
    organized.push(current);
  }

  return organized.map((segment, index) => ({
    ...segment,
    id: `seg-${index}-${segment.startMs}`
  }));
}

export function normalizeCaptionText(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findCurrentSegmentIndex(segments: TranscriptSegment[], currentMs: number): number {
  if (segments.length === 0 || currentMs < segments[0].startMs) {
    return -1;
  }

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (currentMs >= segments[index].startMs) {
      return index;
    }
  }

  return -1;
}

export function applyTranslations(
  segments: TranscriptSegment[],
  translations: string[]
): TranscriptSegment[] {
  return segments.map((segment, index) => ({
    ...segment,
    translation: translations[index]?.trim() || undefined
  }));
}

function splitSegmentsIntoSentencePieces(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.flatMap((segment) => {
    const pieces = splitCaptionTextIntoSentencePieces(segment.text);

    if (pieces.length <= 1) {
      return [segment];
    }

    const totalChars = pieces.reduce((sum, piece) => sum + piece.length, 0);
    let cursorMs = segment.startMs;

    return pieces.map((piece, index) => {
      const isLast = index === pieces.length - 1;
      const pieceDurationMs = isLast
        ? segment.startMs + segment.durationMs - cursorMs
        : Math.max(250, Math.round((segment.durationMs * piece.length) / totalChars));
      const pieceSegment = {
        ...segment,
        id: `${segment.id}-${index}`,
        startMs: cursorMs,
        durationMs: Math.max(250, pieceDurationMs),
        text: piece
      };
      cursorMs += pieceDurationMs;
      return pieceSegment;
    });
  });
}

function splitCaptionTextIntoSentencePieces(text: string): string[] {
  const pieces = text.match(/[^.!?]+[.!?]["')\]]*|[^.!?]+$/g);
  return pieces?.map((piece) => piece.trim()).filter(Boolean) || [text];
}

function shouldStartNewSegment(current: TranscriptSegment, next: TranscriptSegment): boolean {
  const currentEndMs = current.startMs + current.durationMs;
  const gapMs = next.startMs - currentEndMs;
  const mergedLength = current.text.length + next.text.length + 1;

  if (shouldFinalizeSentence(current)) {
    return true;
  }

  if (gapMs > 2800) {
    return true;
  }

  if (gapMs > 1800 && current.text.length < 18) {
    return true;
  }

  return mergedLength > 420;
}

function shouldFinalizeSentence(segment: TranscriptSegment): boolean {
  if (!hasHardSentenceEnd(segment.text)) {
    return false;
  }

  return !endsWithLikelyAbbreviation(segment.text);
}

function hasHardSentenceEnd(text: string): boolean {
  return /[.!?]["')\]]?$/.test(text.trim());
}

function endsWithLikelyAbbreviation(text: string): boolean {
  return /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.$/i.test(text.trim());
}

function isNonSpeechCaption(text: string): boolean {
  return /^(\[[^\]]+\]|\([^)]+\))$/i.test(text.trim());
}

function joinCaptionText(left: string, right: string): string {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return `${left} ${right}`.replace(/\s+/g, ' ').trim();
}
