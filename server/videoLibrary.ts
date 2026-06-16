import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  CaptionLanguage,
  StoredVideoRecord,
  TranscriptPayload,
  TranscriptSegment,
  TranslationPayload,
  VideoHistoryItem,
  VideoSummary
} from '../shared/types';
import { buildYoutubeWatchUrl, extractYoutubeVideoId } from '../shared/youtube';
import { getDataPath } from './paths';

type VideoRecordInput = TranscriptPayload & {
  url: string;
};

type VideoRecordRow = {
  url: string;
  video_id: string;
  source_lang: string;
  languages_json: string;
  video_json: string | null;
  segments_json: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
};

let database: DatabaseSync | null = null;

export function listVideoHistory(limit = 20): VideoHistoryItem[] {
  const rows = getDatabase()
    .prepare(
      `SELECT url, video_id, source_lang, video_json, segments_json, created_at, updated_at, last_opened_at
       FROM video_records
       ORDER BY last_opened_at DESC
       LIMIT ?`
    )
    .all(limit) as Array<Omit<VideoRecordRow, 'languages_json'>>;

  return rows.map((row) => {
    const video = parseJson<VideoSummary | undefined>(row.video_json, undefined);
    const segments = parseJson<TranscriptSegment[]>(row.segments_json, []);

    return {
      videoId: row.video_id,
      url: row.url,
      title: video?.title || row.video_id,
      author: video?.author || '未知频道',
      thumbnailUrl: chooseThumbnailUrl(video),
      sourceLang: row.source_lang,
      segmentCount: segments.length,
      translatedCount: segments.filter((segment) => Boolean(segment.translation)).length,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastOpenedAt: row.last_opened_at
    };
  });
}

export function lookupStoredVideo(inputUrl: string): StoredVideoRecord | null {
  const videoId = extractYoutubeVideoId(inputUrl);

  if (!videoId) {
    return null;
  }

  const canonicalUrl = buildYoutubeWatchUrl(videoId);
  const row =
    findRowByUrl(canonicalUrl) ||
    findRowByUrl(inputUrl.trim()) ||
    findMostRecentRowByVideoId(videoId);

  if (!row) {
    return null;
  }

  touchVideoRecord(row.url);
  return toStoredVideoRecord(row);
}

export function saveTranscriptRecord(input: VideoRecordInput): StoredVideoRecord {
  return saveVideoRecord(input);
}

export function saveTranslationRecord(input: {
  url: string;
  payload: TranslationPayload;
}): StoredVideoRecord {
  const existing = lookupStoredVideo(input.url) || findMostRecentRecordByVideoId(input.payload.videoId);

  return saveVideoRecord({
    url: input.url,
    videoId: input.payload.videoId,
    sourceLang: input.payload.sourceLang,
    languages: existing?.languages || [],
    video: existing?.video,
    segments: input.payload.segments
  });
}

function saveVideoRecord(input: VideoRecordInput): StoredVideoRecord {
  const canonicalUrl = buildYoutubeWatchUrl(input.videoId);
  const now = new Date().toISOString();

  getDatabase()
    .prepare(
      `INSERT INTO video_records (
        url,
        video_id,
        source_lang,
        languages_json,
        video_json,
        segments_json,
        created_at,
        updated_at,
        last_opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        video_id = excluded.video_id,
        source_lang = excluded.source_lang,
        languages_json = excluded.languages_json,
        video_json = excluded.video_json,
        segments_json = excluded.segments_json,
        updated_at = excluded.updated_at,
        last_opened_at = excluded.last_opened_at`
    )
    .run(
      canonicalUrl,
      input.videoId,
      input.sourceLang,
      JSON.stringify(input.languages),
      input.video ? JSON.stringify(input.video) : null,
      JSON.stringify(input.segments),
      now,
      now,
      now
    );

  const row = findRowByUrl(canonicalUrl);

  if (!row) {
    throw new Error('Unable to read saved video record.');
  }

  return toStoredVideoRecord(row);
}

function findMostRecentRecordByVideoId(videoId: string): StoredVideoRecord | null {
  const row = findMostRecentRowByVideoId(videoId);
  return row ? toStoredVideoRecord(row) : null;
}

function findRowByUrl(url: string): VideoRecordRow | null {
  return (
    (getDatabase()
      .prepare(
        `SELECT url, video_id, source_lang, languages_json, video_json, segments_json, created_at, updated_at, last_opened_at
         FROM video_records
         WHERE url = ?`
      )
      .get(url) as VideoRecordRow | undefined) || null
  );
}

function findMostRecentRowByVideoId(videoId: string): VideoRecordRow | null {
  return (
    (getDatabase()
      .prepare(
        `SELECT url, video_id, source_lang, languages_json, video_json, segments_json, created_at, updated_at, last_opened_at
         FROM video_records
         WHERE video_id = ?
         ORDER BY last_opened_at DESC
         LIMIT 1`
      )
      .get(videoId) as VideoRecordRow | undefined) || null
  );
}

function touchVideoRecord(url: string) {
  getDatabase()
    .prepare('UPDATE video_records SET last_opened_at = ? WHERE url = ?')
    .run(new Date().toISOString(), url);
}

function toStoredVideoRecord(row: VideoRecordRow): StoredVideoRecord {
  return {
    url: row.url,
    videoId: row.video_id,
    sourceLang: row.source_lang,
    languages: parseJson<CaptionLanguage[]>(row.languages_json, []),
    video: parseJson<VideoSummary | undefined>(row.video_json, undefined),
    segments: parseJson<TranscriptSegment[]>(row.segments_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at
  };
}

function getDatabase(): DatabaseSync {
  if (database) {
    return database;
  }

  const databasePath = getDataPath('video-library.sqlite');
  mkdirSync(path.dirname(databasePath), { recursive: true });
  database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS video_records (
      url TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      source_lang TEXT NOT NULL,
      languages_json TEXT NOT NULL,
      video_json TEXT,
      segments_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_opened_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_video_records_video_id ON video_records(video_id);
    CREATE INDEX IF NOT EXISTS idx_video_records_last_opened_at ON video_records(last_opened_at DESC);
  `);

  return database;
}

function chooseThumbnailUrl(video: VideoSummary | undefined): string | undefined {
  return video?.thumbnails?.[0]?.url;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
