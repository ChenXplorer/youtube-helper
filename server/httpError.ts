import {
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptInvalidLangError,
  YoutubeTranscriptInvalidVideoIdError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError
} from 'youtube-transcript-plus';

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  if (isJsonParseError(error)) {
    return new HttpError(400, 'INVALID_JSON', '请求体不是有效的 JSON。');
  }

  if (error instanceof YoutubeTranscriptInvalidVideoIdError) {
    return new HttpError(400, 'INVALID_YOUTUBE_URL', '这个 YouTube 链接无效。');
  }

  if (error instanceof YoutubeTranscriptInvalidLangError) {
    return new HttpError(400, 'INVALID_LANGUAGE', `字幕语言代码无效：${error.lang}`);
  }

  if (error instanceof YoutubeTranscriptNotAvailableLanguageError) {
    return new HttpError(
      404,
      'LANGUAGE_NOT_AVAILABLE',
      '这个视频没有请求的字幕语言。',
      { availableLangs: error.availableLangs }
    );
  }

  if (error instanceof YoutubeTranscriptDisabledError) {
    return new HttpError(404, 'TRANSCRIPT_DISABLED', '这个视频关闭了字幕。');
  }

  if (error instanceof YoutubeTranscriptNotAvailableError) {
    return new HttpError(404, 'TRANSCRIPT_NOT_AVAILABLE', '这个视频没有可用字幕。');
  }

  if (error instanceof YoutubeTranscriptVideoUnavailableError) {
    return new HttpError(404, 'VIDEO_UNAVAILABLE', '这个视频不可用或已被移除。');
  }

  if (error instanceof YoutubeTranscriptTooManyRequestError) {
    return new HttpError(429, 'YOUTUBE_RATE_LIMITED', 'YouTube 暂时限制了字幕请求，请稍后再试。');
  }

  if (isFetchFailed(error)) {
    return new HttpError(502, 'UPSTREAM_FETCH_FAILED', '无法连接到 YouTube 或 AI 服务，请检查网络或代理设置。');
  }

  const message = error instanceof Error ? error.message : '未知错误';
  return new HttpError(500, 'INTERNAL_ERROR', message);
}

function isJsonParseError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    typeof (error as { status?: unknown }).status === 'number' &&
    (error as { status?: number }).status === 400 &&
    'body' in error
  );
}

function isFetchFailed(error: unknown): boolean {
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}
