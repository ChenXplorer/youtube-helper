import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FastForward,
  Languages,
  Loader2,
  Pause,
  Play,
  Repeat2,
  Rewind,
  RotateCcw,
  Search,
  SkipBack,
  SkipForward
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchTranscript, translateSegmentsStream } from './api';
import { formatTimestamp } from './time';
import { loadYouTubeIframeApi, type YouTubePlayer } from './youtubePlayer';
import { findCurrentSegmentIndex } from '../shared/transcript';
import type { CaptionLanguage, TranscriptSegment, VideoSummary } from '../shared/types';
import { buildYoutubeWatchUrl } from '../shared/youtube';

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5];
const SEEK_STEP_MS = 5000;

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export default function App() {
  const [url, setUrl] = useState('');
  const [videoId, setVideoId] = useState<string | null>(null);
  const [video, setVideo] = useState<VideoSummary | null>(null);
  const [sourceLang, setSourceLang] = useState('en');
  const [languages, setLanguages] = useState<CaptionLanguage[]>([]);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [error, setError] = useState('');
  const [translateError, setTranslateError] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationProgress, setTranslationProgress] = useState<{ completed: number; total: number } | null>(null);
  const [cacheHit, setCacheHit] = useState<boolean | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [loopCurrent, setLoopCurrent] = useState(false);
  const [loopSegmentIndex, setLoopSegmentIndex] = useState<number | null>(null);

  const playerHostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const transcriptListRef = useRef<HTMLDivElement | null>(null);
  const translationAbortRef = useRef<AbortController | null>(null);

  const currentSegmentIndex = useMemo(
    () => findCurrentSegmentIndex(segments, currentTimeMs),
    [segments, currentTimeMs]
  );
  const currentSegment = currentSegmentIndex >= 0 ? segments[currentSegmentIndex] : null;
  const progress = durationMs > 0 ? Math.min(100, (currentTimeMs / durationMs) * 100) : 0;
  const canUsePlayer = Boolean(videoId && isPlayerReady);
  const translationStatusText = translationProgress
    ? `正在生成中文字幕 ${translationProgress.completed} / ${translationProgress.total}`
    : '正在生成中文字幕';

  const runTranslation = useCallback(
    async (nextVideoId: string, nextSourceLang: string, nextSegments: TranscriptSegment[]) => {
      translationAbortRef.current?.abort();
      const abortController = new AbortController();
      translationAbortRef.current = abortController;
      const untranslatedSegments = clearSegmentTranslations(nextSegments);

      setIsTranslating(true);
      setTranslateError('');
      setCacheHit(null);
      setTranslationProgress({ completed: 0, total: untranslatedSegments.length });
      setSegments(untranslatedSegments);

      try {
        const translated = await translateSegmentsStream({
          videoId: nextVideoId,
          sourceLang: nextSourceLang,
          segments: untranslatedSegments,
          signal: abortController.signal,
          onProgress: (event) => {
            if (abortController.signal.aborted) {
              return;
            }

            setTranslationProgress({ completed: event.completed, total: event.total });

            if (event.type === 'chunk') {
              setSegments((currentSegments) => mergeTranslatedSegments(currentSegments, event.segments));
            }
          }
        });
        setSegments(translated.segments);
        setCacheHit(translated.cacheHit);
      } catch (translationError) {
        if (isAbortError(translationError)) {
          return;
        }

        setTranslateError(translationError instanceof Error ? translationError.message : '翻译失败。');
      } finally {
        if (translationAbortRef.current === abortController) {
          translationAbortRef.current = null;
          setIsTranslating(false);
          setTranslationProgress(null);
        }
      }
    },
    []
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedUrl = url.trim();

    if (!trimmedUrl) {
      setError('请粘贴 YouTube 视频链接。');
      return;
    }

    setLoadState('loading');
    setError('');
    setTranslateError('');
    setCacheHit(null);
    setSegments([]);
    setCurrentTimeMs(0);
    setDurationMs(0);
    setIsPlayerReady(false);
    setLoopCurrent(false);
    setLoopSegmentIndex(null);

    try {
      const payload = await fetchTranscript(trimmedUrl);
      setVideoId(payload.videoId);
      setVideo(payload.video || null);
      setSourceLang(payload.sourceLang);
      setLanguages(payload.languages);
      setSegments(payload.segments);
      setLoadState('ready');
      void runTranslation(payload.videoId, payload.sourceLang, payload.segments);
    } catch (loadError) {
      setLoadState('error');
      setError(loadError instanceof Error ? loadError.message : '字幕加载失败。');
    }
  };

  useEffect(() => {
    if (!videoId || !playerHostRef.current) {
      return;
    }

    let cancelled = false;
    setIsPlayerReady(false);
    setIsPlaying(false);

    loadYouTubeIframeApi()
      .then((YT) => {
        if (cancelled || !playerHostRef.current) {
          return;
        }

        playerRef.current?.destroy();
        playerHostRef.current.innerHTML = '';
        playerRef.current = new YT.Player(playerHostRef.current, {
          videoId,
          playerVars: {
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            cc_load_policy: 0,
            iv_load_policy: 3
          },
          events: {
            onReady: (event) => {
              setIsPlayerReady(true);
              setDurationMs(Math.round(event.target.getDuration() * 1000));
              event.target.setPlaybackRate(playbackRate);
              disableYouTubeCaptions(event.target);
              window.setTimeout(() => disableYouTubeCaptions(event.target), 800);
            },
            onStateChange: (event) => {
              setIsPlaying(event.data === YT.PlayerState.PLAYING);
              disableYouTubeCaptions(event.target);
            }
          }
        });
      })
      .catch((playerError) => {
        setError(playerError instanceof Error ? playerError.message : 'YouTube 播放器加载失败。');
      });

    return () => {
      cancelled = true;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [videoId]);

  useEffect(() => {
    if (!isPlayerReady) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const player = playerRef.current;

      if (!player) {
        return;
      }

      const nextTimeMs = Math.round(player.getCurrentTime() * 1000);
      const nextDurationMs = Math.round(player.getDuration() * 1000);
      setCurrentTimeMs(nextTimeMs);
      setDurationMs(nextDurationMs);

      const activeIndex = findCurrentSegmentIndex(segments, nextTimeMs);
      const activeSegment = activeIndex >= 0 ? segments[activeIndex] : null;
      const lockedLoopSegment =
        loopCurrent && loopSegmentIndex !== null ? segments[loopSegmentIndex] : activeSegment;

      if (
        loopCurrent &&
        lockedLoopSegment &&
        isPlaying &&
        nextTimeMs >= lockedLoopSegment.startMs + Math.max(lockedLoopSegment.durationMs, 500)
      ) {
        player.seekTo(lockedLoopSegment.startMs / 1000, true);
        setCurrentTimeMs(lockedLoopSegment.startMs);
      }
    }, 250);

    return () => window.clearInterval(intervalId);
  }, [isPlayerReady, isPlaying, loopCurrent, loopSegmentIndex, segments]);

  useEffect(() => {
    const activeRow = transcriptListRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (typeof activeRow?.scrollIntoView === 'function') {
      activeRow.scrollIntoView({ block: 'nearest' });
    }
  }, [currentSegmentIndex]);

  const seekToSegment = useCallback((index: number) => {
    const segment = segments[index];

    if (!segment) {
      return;
    }

    playerRef.current?.seekTo(segment.startMs / 1000, true);
    setCurrentTimeMs(segment.startMs);
    if (loopCurrent) {
      setLoopSegmentIndex(index);
    }
  }, [loopCurrent, segments]);

  const togglePlay = () => {
    const player = playerRef.current;

    if (!player) {
      return;
    }

    if (isPlaying) {
      player.pauseVideo();
      setIsPlaying(false);
    } else {
      player.playVideo();
      setIsPlaying(true);
    }
  };

  const goToPrevious = () => {
    const nextIndex = currentSegmentIndex > 0 ? currentSegmentIndex - 1 : 0;
    seekToSegment(nextIndex);
  };

  const goToNext = () => {
    const nextIndex = Math.min(segments.length - 1, currentSegmentIndex + 1);
    seekToSegment(nextIndex);
  };

  const seekBy = (offsetMs: number) => {
    const player = playerRef.current;

    if (!player) {
      return;
    }

    const duration = Math.max(durationMs, Math.round(player.getDuration() * 1000));
    const nextTimeMs = Math.min(Math.max(currentTimeMs + offsetMs, 0), duration || Number.MAX_SAFE_INTEGER);
    player.seekTo(nextTimeMs / 1000, true);
    setCurrentTimeMs(nextTimeMs);
    if (loopCurrent) {
      const nextIndex = findCurrentSegmentIndex(segments, nextTimeMs);
      setLoopSegmentIndex(nextIndex >= 0 ? nextIndex : null);
    }
  };

  const toggleLoopCurrent = () => {
    if (loopCurrent) {
      setLoopCurrent(false);
      setLoopSegmentIndex(null);
      return;
    }

    const nextIndex = currentSegmentIndex >= 0 ? currentSegmentIndex : 0;
    setLoopSegmentIndex(nextIndex);
    setLoopCurrent(true);
    if (currentSegmentIndex < 0 && segments[nextIndex]) {
      seekToSegment(nextIndex);
    }
  };

  const changePlaybackRate = (rate: number) => {
    setPlaybackRate(rate);
    playerRef.current?.setPlaybackRate(rate);
  };

  return (
    <main className="app-shell">
      <section className="topbar" aria-label="视频加载">
        <div className="brand">
          <span className="brand-mark">YT</span>
          <div>
            <h1>YouTube 英语学习器</h1>
            <p>{video?.author || '本地学习工作台'}</p>
          </div>
        </div>

        <form className="url-form" onSubmit={handleSubmit}>
          <label htmlFor="youtube-url">YouTube 链接</label>
          <div className="url-row">
            <input
              id="youtube-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              type="url"
            />
            <button className="primary-button" disabled={loadState === 'loading'} type="submit">
              {loadState === 'loading' ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
              载入
            </button>
          </div>
        </form>
      </section>

      <section className="workspace">
        <div className="player-pane">
          <div className="video-shell">
            {videoId ? (
              <div className="player-frame" ref={playerHostRef} />
            ) : (
              <div className="video-empty">
                <div className="video-empty-badge">YouTube</div>
                <span>等待视频</span>
              </div>
            )}
          </div>

          <div className="study-panel" aria-live="polite">
            <div className="study-panel-header">
              <span>当前字幕</span>
              <span>
                {currentSegmentIndex >= 0
                  ? `${currentSegmentIndex + 1} / ${segments.length} · ${formatTimestamp(currentSegment?.startMs || 0)}`
                  : '等待播放'}
              </span>
            </div>

            <div className="current-line">
              <p className="current-english">{currentSegment ? currentSegment.text : video?.title || '载入视频后显示当前字幕'}</p>
              <small className="current-translation">
                {currentSegment?.translation ||
                  (isTranslating ? '正在生成中文翻译...' : '中文翻译会显示在这里')}
              </small>
            </div>

            <div className="timeline">
              <span>{formatTimestamp(currentTimeMs)}</span>
              <div className="timeline-track" aria-hidden="true">
                <div className="timeline-fill" style={{ width: `${progress}%` }} />
              </div>
              <span>{formatTimestamp(durationMs)}</span>
            </div>

            <div className="control-row">
              <button className="text-control" title="上一句" disabled={!canUsePlayer || segments.length === 0} onClick={goToPrevious}>
                <SkipBack size={18} />
                <span>上一句</span>
              </button>
              <button className="text-control" title="后退 5 秒" disabled={!canUsePlayer} onClick={() => seekBy(-SEEK_STEP_MS)}>
                <Rewind size={18} />
                <span>后退</span>
              </button>
              <button className="play-button" title={isPlaying ? '暂停' : '播放'} disabled={!canUsePlayer} onClick={togglePlay}>
                {isPlaying ? <Pause size={20} /> : <Play size={20} />}
              </button>
              <button className="text-control" title="快进 5 秒" disabled={!canUsePlayer} onClick={() => seekBy(SEEK_STEP_MS)}>
                <FastForward size={18} />
                <span>快进</span>
              </button>
              <button className="text-control" title="下一句" disabled={!canUsePlayer || segments.length === 0} onClick={goToNext}>
                <SkipForward size={18} />
                <span>下一句</span>
              </button>
              <button
                className={`text-control${loopCurrent ? ' is-active' : ''}`}
                title="单句循环"
                disabled={!canUsePlayer || segments.length === 0}
                onClick={toggleLoopCurrent}
              >
                <Repeat2 size={18} />
                <span>循环</span>
              </button>
              <label className="rate-control">
                倍速
                <select
                  value={playbackRate}
                  disabled={!canUsePlayer}
                  onChange={(event) => changePlaybackRate(Number(event.target.value))}
                >
                  {PLAYBACK_RATES.map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}x
                    </option>
                  ))}
                </select>
              </label>
              {videoId ? (
                <a className="open-youtube" href={buildYoutubeWatchUrl(videoId)} target="_blank" rel="noreferrer" title="打开 YouTube">
                  <ExternalLink size={18} />
                </a>
              ) : null}
            </div>
          </div>
        </div>

        <aside className="transcript-pane">
          <div className="mode-tabs" aria-label="学习模式">
            {['双语', '英语', '中文', '听写', '挖空', '阅读', '中译英', '词卡'].map((tab, index) => (
              <button className={index === 0 ? 'is-active' : ''} key={tab} type="button">
                {tab}
              </button>
            ))}
          </div>

          <div className="pane-header">
            <div>
              <h2>双语字幕</h2>
              <p>
                {segments.length > 0
                  ? `${segments.length} 句 · ${sourceLang.toUpperCase()}`
                  : languages.length > 0
                    ? `${languages.length} 种字幕`
                    : '等待字幕'}
              </p>
            </div>
            <button
              title="重新翻译"
              disabled={!videoId || segments.length === 0 || isTranslating}
              onClick={() => videoId && runTranslation(videoId, sourceLang, segments)}
            >
              {isTranslating ? <Loader2 className="spin" size={18} /> : <RotateCcw size={18} />}
            </button>
          </div>

          {error ? <StatusBanner tone="danger" icon={<AlertCircle size={18} />} text={error} /> : null}
          {translateError ? <StatusBanner tone="warning" icon={<Languages size={18} />} text={translateError} /> : null}
          {isTranslating ? <StatusBanner tone="neutral" icon={<Loader2 className="spin" size={18} />} text={translationStatusText} /> : null}
          {cacheHit ? <StatusBanner tone="success" icon={<CheckCircle2 size={18} />} text="已使用本地翻译缓存" /> : null}

          <div className="transcript-list" ref={transcriptListRef}>
            {segments.length === 0 ? (
              <div className="empty-transcript">
                {loadState === 'loading' ? '正在读取字幕' : '暂无字幕'}
              </div>
            ) : (
              segments.map((segment, index) => {
                const isActive = index === currentSegmentIndex;

                return (
                  <button
                    key={segment.id}
                    className={`transcript-row${isActive ? ' is-active' : ''}`}
                    data-active={isActive}
                    onClick={() => seekToSegment(index)}
                  >
                    <span className="segment-time">{formatTimestamp(segment.startMs)}</span>
                    <span className="segment-copy">
                      <strong>{segment.text}</strong>
                      {segment.translation ? <small>{segment.translation}</small> : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}

function StatusBanner({
  icon,
  text,
  tone
}: {
  icon: React.ReactNode;
  text: string;
  tone: 'danger' | 'neutral' | 'success' | 'warning';
}) {
  return (
    <div className={`status-banner ${tone}`}>
      {icon}
      <span>{text}</span>
    </div>
  );
}

function clearSegmentTranslations(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.map(({ translation, ...segment }) => segment);
}

function mergeTranslatedSegments(
  currentSegments: TranscriptSegment[],
  translatedSegments: TranscriptSegment[]
): TranscriptSegment[] {
  const translationsById = new Map(
    translatedSegments
      .filter((segment) => segment.translation)
      .map((segment) => [segment.id, segment.translation])
  );

  if (translationsById.size === 0) {
    return currentSegments;
  }

  return currentSegments.map((segment) => {
    const translation = translationsById.get(segment.id);

    return translation ? { ...segment, translation } : segment;
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function disableYouTubeCaptions(player: YouTubePlayer) {
  player.setOption?.('captions', 'track', {});
  player.setOption?.('cc', 'track', {});
  player.unloadModule?.('captions');
  player.unloadModule?.('cc');
}
