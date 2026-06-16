import type {
  ApiErrorPayload,
  TranscriptPayload,
  TranscriptSegment,
  TranslationPayload,
  TranslationStreamChunk,
  TranslationStreamDone,
  TranslationStreamEvent
} from '../shared/types';

export async function fetchTranscript(url: string): Promise<TranscriptPayload> {
  return postJson<TranscriptPayload>('/api/transcript', {
    url,
    lang: 'en'
  });
}

export async function translateSegments({
  videoId,
  sourceLang,
  segments,
  signal
}: {
  videoId: string;
  sourceLang: string;
  segments: TranscriptSegment[];
  signal?: AbortSignal;
}): Promise<TranslationPayload> {
  return postJson<TranslationPayload>('/api/translate', {
    videoId,
    sourceLang,
    targetLang: 'zh-CN',
    segments
  }, signal);
}

export async function translateSegmentsStream({
  videoId,
  sourceLang,
  segments,
  signal,
  onProgress
}: {
  videoId: string;
  sourceLang: string;
  segments: TranscriptSegment[];
  signal?: AbortSignal;
  onProgress?: (event: TranslationStreamChunk | TranslationStreamDone) => void;
}): Promise<TranslationPayload> {
  const response = await fetch('/api/translate/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      videoId,
      sourceLang,
      targetLang: 'zh-CN',
      segments
    }),
    signal
  });

  if (response.status === 404) {
    return translateSegments({ videoId, sourceLang, segments, signal });
  }

  if (!response.ok) {
    const payload = await readErrorPayload(response);
    throw new ApiClientError(
      response.status,
      payload?.error.code || 'REQUEST_FAILED',
      payload?.error.message || response.statusText,
      payload?.error.details
    );
  }

  if (!response.body) {
    return translateSegments({ videoId, sourceLang, segments, signal });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalPayload: TranslationPayload | null = null;

  const handleLine = (line: string) => {
    const trimmed = line.trim();

    if (!trimmed) {
      return;
    }

    const event = JSON.parse(trimmed) as TranslationStreamEvent;

    if (event.type === 'error') {
      throw new ApiClientError(
        event.status,
        event.error.code,
        event.error.message,
        event.error.details
      );
    }

    onProgress?.(event);

    if (event.type === 'done') {
      finalPayload = {
        videoId: event.videoId,
        sourceLang: event.sourceLang,
        targetLang: event.targetLang,
        cacheHit: event.cacheHit,
        segments: event.segments
      };
    }
  };

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    lines.forEach(handleLine);
  }

  buffer += decoder.decode();
  handleLine(buffer);

  if (!finalPayload) {
    throw new ApiClientError(502, 'TRANSLATION_STREAM_ENDED', '翻译响应提前结束。');
  }

  return finalPayload;
}

export class ApiClientError extends Error {
  code: string;
  status: number;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const payload = await readErrorPayload(response);
    throw new ApiClientError(
      response.status,
      payload?.error.code || 'REQUEST_FAILED',
      payload?.error.message || response.statusText,
      payload?.error.details
    );
  }

  return (await response.json()) as T;
}

async function readErrorPayload(response: Response): Promise<ApiErrorPayload | null> {
  try {
    return (await response.json()) as ApiErrorPayload;
  } catch {
    return null;
  }
}
