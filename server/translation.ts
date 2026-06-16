import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyTranslations } from '../shared/transcript';
import type {
  TranscriptSegment,
  TranslationPayload,
  TranslationStreamChunk,
  TranslationStreamDone
} from '../shared/types';
import { HttpError } from './httpError';
import { getDataPath } from './paths';

type TranslateRequest = {
  videoId: string;
  sourceLang: string;
  targetLang: string;
  segments: TranscriptSegment[];
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type TranslationChunk = {
  startIndex: number;
  segments: TranscriptSegment[];
};

type TranslationChunkResult = {
  chunkIndex: number;
  startIndex: number;
  segments: TranscriptSegment[];
  translations: string[];
};

const DEFAULT_OPENAI_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_OPENAI_MODEL = 'deepseek-v4-flash';
const DEFAULT_TRANSLATION_CONCURRENCY = 4;
const DEFAULT_TRANSLATION_CHUNK_SEGMENTS = 12;
const DEFAULT_TRANSLATION_CHUNK_CHARS = 1800;

export async function translateTranscript(request: TranslateRequest): Promise<TranslationPayload> {
  if (request.segments.length === 0) {
    throw new HttpError(400, 'EMPTY_TRANSCRIPT', '没有可翻译的字幕。');
  }

  const cachePath = getTranslationCachePath(request);
  const cachedTranslations = await readCachedTranslations(cachePath, request.segments.length);

  if (cachedTranslations) {
    return {
      videoId: request.videoId,
      sourceLang: request.sourceLang,
      targetLang: request.targetLang,
      cacheHit: true,
      segments: applyTranslations(request.segments, cachedTranslations)
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new HttpError(400, 'AI_NOT_CONFIGURED', '还没有配置 OPENAI_API_KEY，无法生成中文字幕。');
  }

  const chunks = chunkSegments(request.segments);
  const translatedChunks = await runWithConcurrency(
    chunks,
    getTranslationConcurrency(),
    async (chunk) =>
      translateChunk({
        apiKey,
        sourceLang: request.sourceLang,
        targetLang: request.targetLang,
        items: buildTranslationItems(chunk)
      })
  );
  const translations = translatedChunks.flat();

  if (translations.length !== request.segments.length) {
    throw new HttpError(502, 'AI_TRANSLATION_MISMATCH', 'AI 返回的翻译数量和字幕数量不一致。');
  }

  await writeCachedTranslations(cachePath, translations);

  return {
    videoId: request.videoId,
    sourceLang: request.sourceLang,
    targetLang: request.targetLang,
    cacheHit: false,
    segments: applyTranslations(request.segments, translations)
  };
}

export async function* translateTranscriptStream(
  request: TranslateRequest
): AsyncGenerator<TranslationStreamChunk | TranslationStreamDone> {
  if (request.segments.length === 0) {
    throw new HttpError(400, 'EMPTY_TRANSCRIPT', '没有可翻译的字幕。');
  }

  const cachePath = getTranslationCachePath(request);
  const cachedTranslations = await readCachedTranslations(cachePath, request.segments.length);

  if (cachedTranslations) {
    yield {
      type: 'done',
      videoId: request.videoId,
      sourceLang: request.sourceLang,
      targetLang: request.targetLang,
      cacheHit: true,
      completed: request.segments.length,
      total: request.segments.length,
      segments: applyTranslations(request.segments, cachedTranslations)
    };
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new HttpError(400, 'AI_NOT_CONFIGURED', '还没有配置 OPENAI_API_KEY，无法生成中文字幕。');
  }

  const chunks = chunkSegments(request.segments);
  const translationsByIndex = new Array<string | undefined>(request.segments.length);
  let completed = 0;

  for await (const result of translateChunksAsCompleted({
    apiKey,
    sourceLang: request.sourceLang,
    targetLang: request.targetLang,
    chunks
  })) {
    result.translations.forEach((translation, index) => {
      translationsByIndex[result.startIndex + index] = translation;
    });
    completed += result.translations.length;

    yield {
      type: 'chunk',
      videoId: request.videoId,
      sourceLang: request.sourceLang,
      targetLang: request.targetLang,
      cacheHit: false,
      completed,
      total: request.segments.length,
      segments: applyTranslations(result.segments, result.translations)
    };
  }

  const translations = request.segments.map((_segment, index) => {
    const translation = translationsByIndex[index];

    if (typeof translation !== 'string') {
      throw new HttpError(502, 'AI_TRANSLATION_MISMATCH', 'AI 返回的翻译数量和字幕数量不一致。');
    }

    return translation;
  });

  await writeCachedTranslations(cachePath, translations);

  yield {
    type: 'done',
    videoId: request.videoId,
    sourceLang: request.sourceLang,
    targetLang: request.targetLang,
    cacheHit: false,
    completed: request.segments.length,
    total: request.segments.length,
    segments: applyTranslations(request.segments, translations)
  };
}

export function buildTranslationCacheKey(request: TranslateRequest): string {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      version: 1,
      videoId: request.videoId,
      sourceLang: request.sourceLang,
      targetLang: request.targetLang,
      segments: request.segments.map((segment) => ({
        startMs: segment.startMs,
        durationMs: segment.durationMs,
        text: segment.text
      }))
    })
  );
  return hash.digest('hex').slice(0, 24);
}

function getTranslationCachePath(request: TranslateRequest): string {
  const key = buildTranslationCacheKey(request);
  const safeVideoId = request.videoId.replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(getDataPath('translations'), `${safeVideoId}-${request.sourceLang}-${request.targetLang}-${key}.json`);
}

async function readCachedTranslations(cachePath: string, expectedLength: number): Promise<string[] | null> {
  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as { translations?: unknown };

    if (
      Array.isArray(parsed.translations) &&
      parsed.translations.length === expectedLength &&
      parsed.translations.every((item) => typeof item === 'string')
    ) {
      return parsed.translations;
    }
  } catch {
    return null;
  }

  return null;
}

async function writeCachedTranslations(cachePath: string, translations: string[]): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        translations
      },
      null,
      2
    ),
    'utf8'
  );
}

function chunkSegments(segments: TranscriptSegment[]): TranslationChunk[] {
  const chunks: TranslationChunk[] = [];
  let current: TranscriptSegment[] = [];
  let currentStartIndex = 0;
  let charCount = 0;
  const maxSegments = getTranslationChunkSegmentLimit();
  const maxChars = getTranslationChunkCharLimit();

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const nextCount = charCount + segment.text.length;

    if (current.length > 0 && (current.length >= maxSegments || nextCount > maxChars)) {
      chunks.push({ startIndex: currentStartIndex, segments: current });
      current = [];
      currentStartIndex = index;
      charCount = 0;
    }

    if (current.length === 0) {
      currentStartIndex = index;
    }

    current.push(segment);
    charCount += segment.text.length;
  }

  if (current.length > 0) {
    chunks.push({ startIndex: currentStartIndex, segments: current });
  }

  return chunks;
}

function buildTranslationItems(chunk: TranslationChunk): Array<{ index: number; id: string; text: string }> {
  return chunk.segments.map((segment, index) => ({
    index: chunk.startIndex + index,
    id: segment.id,
    text: segment.text
  }));
}

function getTranslationConcurrency(): number {
  const configured = Number(process.env.TRANSLATION_CONCURRENCY || DEFAULT_TRANSLATION_CONCURRENCY);

  if (!Number.isFinite(configured)) {
    return DEFAULT_TRANSLATION_CONCURRENCY;
  }

  return Math.min(8, Math.max(1, Math.floor(configured)));
}

function getTranslationChunkSegmentLimit(): number {
  const configured = Number(process.env.TRANSLATION_CHUNK_SEGMENTS || DEFAULT_TRANSLATION_CHUNK_SEGMENTS);

  if (!Number.isFinite(configured)) {
    return DEFAULT_TRANSLATION_CHUNK_SEGMENTS;
  }

  return Math.min(30, Math.max(4, Math.floor(configured)));
}

function getTranslationChunkCharLimit(): number {
  const configured = Number(process.env.TRANSLATION_CHUNK_CHARS || DEFAULT_TRANSLATION_CHUNK_CHARS);

  if (!Number.isFinite(configured)) {
    return DEFAULT_TRANSLATION_CHUNK_CHARS;
  }

  return Math.min(5000, Math.max(600, Math.floor(configured)));
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const index = nextIndex;
    nextIndex += 1;

    if (index >= items.length) {
      return;
    }

    results[index] = await worker(items[index], index);
    await runNext();
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runNext())
  );

  return results;
}

async function* translateChunksAsCompleted({
  apiKey,
  sourceLang,
  targetLang,
  chunks
}: {
  apiKey: string;
  sourceLang: string;
  targetLang: string;
  chunks: TranslationChunk[];
}): AsyncGenerator<TranslationChunkResult> {
  const queue: TranslationChunkResult[] = [];
  let nextIndex = 0;
  let isDone = false;
  let fatalError: unknown;
  let notify: (() => void) | null = null;

  const wake = () => {
    notify?.();
    notify = null;
  };

  const push = (result: TranslationChunkResult) => {
    queue.push(result);
    wake();
  };

  const workers = Array.from(
    { length: Math.min(getTranslationConcurrency(), chunks.length) },
    async () => {
      while (!fatalError) {
        const chunkIndex = nextIndex;
        nextIndex += 1;

        if (chunkIndex >= chunks.length) {
          return;
        }

        const chunk = chunks[chunkIndex];

        try {
          const translations = await translateChunk({
            apiKey,
            sourceLang,
            targetLang,
            items: buildTranslationItems(chunk)
          });

          push({
            chunkIndex,
            startIndex: chunk.startIndex,
            segments: chunk.segments,
            translations
          });
        } catch (error) {
          fatalError = error;
          wake();
          return;
        }
      }
    }
  );

  const completion = Promise.allSettled(workers).then(() => {
    isDone = true;
    wake();
  });

  while (!isDone || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }

    while (queue.length > 0) {
      yield queue.shift() as TranslationChunkResult;
    }

    if (fatalError) {
      await completion;
      throw fatalError;
    }
  }

  await completion;

  if (fatalError) {
    throw fatalError;
  }
}

async function translateChunk({
  apiKey,
  sourceLang,
  targetLang,
  items
}: {
  apiKey: string;
  sourceLang: string;
  targetLang: string;
  items: Array<{ index: number; id: string; text: string }>;
}): Promise<string[]> {
  try {
    return await requestTranslationChunk({
      apiKey,
      sourceLang,
      targetLang,
      items
    });
  } catch (error) {
    if (items.length <= 1 || !isRecoverableTranslationError(error)) {
      throw error;
    }

    const middle = Math.ceil(items.length / 2);
    const left = await translateChunk({
      apiKey,
      sourceLang,
      targetLang,
      items: items.slice(0, middle)
    });
    const right = await translateChunk({
      apiKey,
      sourceLang,
      targetLang,
      items: items.slice(middle)
    });

    return [...left, ...right];
  }
}

async function requestTranslationChunk({
  apiKey,
  sourceLang,
  targetLang,
  items
}: {
  apiKey: string;
  sourceLang: string;
  targetLang: string;
  items: Array<{ index: number; id: string; text: string }>;
}): Promise<string[]> {
  const baseUrl = (process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  const model = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You translate subtitle segments into natural Simplified Chinese for English learners. Do not merge, split, omit, summarize, or reorder segments. Return only valid JSON in this exact shape: {"translations":[{"id":"same id from input","text":"Chinese translation"}]}. Return every input id exactly once.'
        },
        {
          role: 'user',
          content: JSON.stringify({
            sourceLang,
            targetLang,
            items
          })
        }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new HttpError(502, 'AI_REQUEST_FAILED', `AI 翻译请求失败：${body || response.statusText}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new HttpError(502, 'AI_EMPTY_RESPONSE', 'AI 没有返回翻译内容。');
  }

  const translations = parseTranslationResponse(content, items);

  if (translations.length !== items.length) {
    throw new HttpError(502, 'AI_TRANSLATION_MISMATCH', 'AI 返回的翻译数量和字幕数量不一致。');
  }

  return translations;
}

function parseTranslationResponse(
  content: string,
  items: Array<{ id: string; text: string }>
): string[] {
  const parsed = parseJsonValue(content);
  const translationsValue =
    Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.translations : null;

  if (!Array.isArray(translationsValue)) {
    throw new HttpError(502, 'AI_INVALID_JSON', 'AI 没有返回 JSON 数组。');
  }

  if (translationsValue.every((item) => typeof item === 'string')) {
    return translationsValue;
  }

  if (!translationsValue.every(isTranslationObject)) {
    throw new HttpError(502, 'AI_INVALID_JSON', 'AI 返回的 JSON 数组格式不正确。');
  }

  const byId = new Map(translationsValue.map((item) => [item.id, item.text.trim()]));
  const ordered = items.map((item) => byId.get(item.id) || '');

  if (ordered.some((translation) => translation.length === 0)) {
    throw new HttpError(502, 'AI_TRANSLATION_MISMATCH', 'AI 返回的翻译数量和字幕数量不一致。');
  }

  return ordered;
}

function parseJsonValue(content: string): unknown {
  const trimmed = content.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(withoutFence) as unknown;
  } catch {
    const objectStart = withoutFence.indexOf('{');
    const objectEnd = withoutFence.lastIndexOf('}');
    const arrayStart = withoutFence.indexOf('[');
    const arrayEnd = withoutFence.lastIndexOf(']');
    const candidate =
      objectStart !== -1 && objectEnd > objectStart
        ? withoutFence.slice(objectStart, objectEnd + 1)
        : arrayStart !== -1 && arrayEnd > arrayStart
          ? withoutFence.slice(arrayStart, arrayEnd + 1)
          : '';

    if (!candidate) {
      throw new HttpError(502, 'AI_INVALID_JSON', 'AI 没有返回 JSON 数组。');
    }

    return JSON.parse(candidate) as unknown;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTranslationObject(value: unknown): value is { id: string; text: string } {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.text === 'string'
  );
}

function isRecoverableTranslationError(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    ['AI_INVALID_JSON', 'AI_TRANSLATION_MISMATCH', 'AI_EMPTY_RESPONSE'].includes(error.code)
  );
}
