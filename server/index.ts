import cors from 'cors';
import dotenv from 'dotenv';
import express, { type ErrorRequestHandler } from 'express';
import { getTranscript } from './transcripts';
import { translateTranscript, translateTranscriptStream } from './translation';
import { HttpError, toHttpError } from './httpError';
import { listVideoHistory, lookupStoredVideo, saveTranscriptRecord, saveTranslationRecord } from './videoLibrary';
import { buildYoutubeWatchUrl } from '../shared/youtube';

dotenv.config();

export function createApp() {
  const app = express();

  app.use(cors({ origin: true }));
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true });
  });

  app.get('/api/library/videos', (_request, response) => {
    response.json({ items: listVideoHistory() });
  });

  app.post('/api/library/lookup', (request, response, next) => {
    try {
      const url = requireString(request.body?.url, 'url');
      response.json({ record: lookupStoredVideo(url) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/transcript', async (request, response, next) => {
    try {
      const url = requireString(request.body?.url, 'url');
      const lang = typeof request.body?.lang === 'string' ? request.body.lang : 'en';
      const payload = await getTranscript(url, lang);
      saveTranscriptRecord({ url, ...payload });
      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/translate', async (request, response, next) => {
    try {
      const videoId = requireString(request.body?.videoId, 'videoId');
      const sourceLang = requireString(request.body?.sourceLang, 'sourceLang');
      const targetLang = requireString(request.body?.targetLang, 'targetLang');
      const url = getRequestVideoUrl(request.body?.url, videoId);
      const segments = Array.isArray(request.body?.segments) ? request.body.segments : null;

      if (!segments) {
        throw new HttpError(400, 'INVALID_SEGMENTS', 'segments 必须是数组。');
      }

      const payload = await translateTranscript({
        videoId,
        sourceLang,
        targetLang,
        segments
      });
      saveTranslationRecord({ url, payload });
      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/translate/stream', async (request, response, next) => {
    try {
      const videoId = requireString(request.body?.videoId, 'videoId');
      const sourceLang = requireString(request.body?.sourceLang, 'sourceLang');
      const targetLang = requireString(request.body?.targetLang, 'targetLang');
      const url = getRequestVideoUrl(request.body?.url, videoId);
      const segments = Array.isArray(request.body?.segments) ? request.body.segments : null;

      if (!segments) {
        throw new HttpError(400, 'INVALID_SEGMENTS', 'segments 必须是数组。');
      }

      response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('X-Accel-Buffering', 'no');

      for await (const event of translateTranscriptStream({
        videoId,
        sourceLang,
        targetLang,
        segments
      })) {
        response.write(`${JSON.stringify(event)}\n`);

        if (event.type === 'done') {
          saveTranslationRecord({ url, payload: event });
        }
      }

      response.end();
    } catch (error) {
      if (!response.headersSent) {
        next(error);
        return;
      }

      const httpError = toHttpError(error);
      response.write(
        `${JSON.stringify({
          type: 'error',
          status: httpError.status,
          error: {
            code: httpError.code,
            message: httpError.message,
            details: httpError.details
          }
        })}\n`
      );
      response.end();
    }
  });

  app.use(errorHandler);

  return app;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'INVALID_REQUEST', `${fieldName} 不能为空。`);
  }

  return value.trim();
}

function getRequestVideoUrl(value: unknown, videoId: string): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : buildYoutubeWatchUrl(videoId);
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  const httpError = toHttpError(error);
  response.status(httpError.status).json({
    error: {
      code: httpError.code,
      message: httpError.message,
      details: httpError.details
    }
  });
};

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT || 8787);
  createApp().listen(port, '127.0.0.1', () => {
    console.log(`API server listening on http://127.0.0.1:${port}`);
  });
}
