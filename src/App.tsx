import {
  AlertCircle,
  CheckCircle2,
  Database,
  ExternalLink,
  FastForward,
  History,
  Languages,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Repeat2,
  Rewind,
  RotateCcw,
  Search,
  SkipBack,
  SkipForward,
  X
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchTranscript, fetchVideoHistory, lookupStoredVideo, translateSegmentsStream } from './api';
import { formatTimestamp } from './time';
import { loadYouTubeIframeApi, type YouTubePlayer } from './youtubePlayer';
import { findCurrentSegmentIndex } from '../shared/transcript';
import type {
  CaptionLanguage,
  StoredVideoRecord,
  TranscriptSegment,
  VideoHistoryItem,
  VideoSummary
} from '../shared/types';
import { buildYoutubeWatchUrl } from '../shared/youtube';

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5];
const SEEK_STEP_MS = 5000;

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export default function App() {
  const [url, setUrl] = useState('');
  const [videoId, setVideoId] = useState<string | null>(null);
  const [video, setVideo] = useState<VideoSummary | null>(null);
  const [historyItems, setHistoryItems] = useState<VideoHistoryItem[]>([]);
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [sourceLang, setSourceLang] = useState('en');
  const [languages, setLanguages] = useState<CaptionLanguage[]>([]);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [error, setError] = useState('');
  const [translateError, setTranslateError] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationProgress, setTranslationProgress] = useState<{ completed: number; total: number } | null>(null);
  const [cacheHit, setCacheHit] = useState<boolean | null>(null);
  const [loadedFromLibrary, setLoadedFromLibrary] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [isTranscriptPaneOpen, setIsTranscriptPaneOpen] = useState(true);
  const [isVideoFullscreen, setIsVideoFullscreen] = useState(false);
  const [isCinemaMode, setIsCinemaMode] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [loopCurrent, setLoopCurrent] = useState(false);
  const [loopSegmentIndex, setLoopSegmentIndex] = useState<number | null>(null);

  const playerHostRef = useRef<HTMLDivElement | null>(null);
  const videoShellRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const transcriptListRef = useRef<HTMLDivElement | null>(null);
  const translationAbortRef = useRef<AbortController | null>(null);

  const currentSegmentIndex = useMemo(
    () => findCurrentSegmentIndex(segments, currentTimeMs),
    [segments, currentTimeMs]
  );
  const currentSegment = currentSegmentIndex >= 0 ? segments[currentSegmentIndex] : null;
  const displaySegmentIndex = currentSegmentIndex >= 0 ? currentSegmentIndex : segments.length > 0 ? 0 : -1;
  const displaySegment = currentSegment || segments[0] || null;
  const progress = durationMs > 0 ? Math.min(100, (currentTimeMs / durationMs) * 100) : 0;
  const canUsePlayer = Boolean(videoId && isPlayerReady);
  const isVideoExpanded = isVideoFullscreen || isCinemaMode;
  const isLoopActive = loopCurrent && loopSegmentIndex !== null;
  const translationStatusText = translationProgress
    ? `正在生成中文字幕 ${translationProgress.completed} / ${translationProgress.total}`
    : '正在生成中文字幕';
  const filteredHistoryItems = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();

    if (!query) {
      return historyItems;
    }

    return historyItems.filter((item) =>
      [item.title, item.author, item.url, item.videoId]
        .some((value) => value.toLowerCase().includes(query))
    );
  }, [historyItems, historyQuery]);

  const refreshHistory = useCallback(async () => {
    try {
      const payload = await fetchVideoHistory();
      setHistoryItems(payload.items);
    } catch {
      setHistoryItems([]);
    }
  }, []);

  const restoreStoredVideo = useCallback((record: StoredVideoRecord) => {
    translationAbortRef.current?.abort();
    setUrl(record.url);
    setVideoId(record.videoId);
    setVideo(record.video || null);
    setSourceLang(record.sourceLang);
    setLanguages(record.languages);
    setSegments(record.segments);
    setLoadState('ready');
    setError('');
    setTranslateError('');
    setCacheHit(null);
    setLoadedFromLibrary(true);
    setIsTranslating(false);
    setTranslationProgress(null);
    setCurrentTimeMs(0);
    setDurationMs(0);
    setIsPlayerReady(false);
    setIsCinemaMode(false);
    setLoopCurrent(false);
    setLoopSegmentIndex(null);
  }, []);

  const runTranslation = useCallback(
    async (nextUrl: string, nextVideoId: string, nextSourceLang: string, nextSegments: TranscriptSegment[]) => {
      translationAbortRef.current?.abort();
      const abortController = new AbortController();
      translationAbortRef.current = abortController;
      const untranslatedSegments = clearSegmentTranslations(nextSegments);

      setIsTranslating(true);
      setTranslateError('');
      setCacheHit(null);
      setLoadedFromLibrary(false);
      setTranslationProgress({ completed: 0, total: untranslatedSegments.length });
      setSegments(untranslatedSegments);

      try {
        const translated = await translateSegmentsStream({
          url: nextUrl,
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
        void refreshHistory();
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
    [refreshHistory]
  );

  const loadVideoFromUrl = useCallback(
    async (nextUrl: string) => {
      const trimmedUrl = nextUrl.trim();

      if (!trimmedUrl) {
        setError('请粘贴 YouTube 视频链接。');
        return;
      }

      translationAbortRef.current?.abort();
      setUrl(trimmedUrl);
      setLoadState('loading');
      setError('');
      setTranslateError('');
      setCacheHit(null);
      setLoadedFromLibrary(false);
      setSegments([]);
      setCurrentTimeMs(0);
      setDurationMs(0);
      setIsPlayerReady(false);
      setIsCinemaMode(false);
      setLoopCurrent(false);
      setLoopSegmentIndex(null);

      try {
        const cached = await lookupStoredVideo(trimmedUrl);

        if (cached.record) {
          restoreStoredVideo(cached.record);
          void refreshHistory();

          if (!hasCompleteTranslations(cached.record.segments)) {
            void runTranslation(cached.record.url, cached.record.videoId, cached.record.sourceLang, cached.record.segments);
          }

          return;
        }

        const payload = await fetchTranscript(trimmedUrl);
        setVideoId(payload.videoId);
        setVideo(payload.video || null);
        setSourceLang(payload.sourceLang);
        setLanguages(payload.languages);
        setSegments(payload.segments);
        setLoadState('ready');
        void refreshHistory();
        void runTranslation(trimmedUrl, payload.videoId, payload.sourceLang, payload.segments);
      } catch (loadError) {
        setLoadState('error');
        setError(loadError instanceof Error ? loadError.message : '字幕加载失败。');
      }
    },
    [refreshHistory, restoreStoredVideo, runTranslation]
  );

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!url.trim()) {
      setError('请粘贴 YouTube 视频链接。');
      return;
    }

    setIsUrlModalOpen(false);
    void loadVideoFromUrl(url);
  };

  const openUrlModal = () => {
    setIsUrlModalOpen(true);
  };

  const closeUrlModal = () => {
    setIsUrlModalOpen(false);
  };

  const openHistory = () => {
    setIsHistoryOpen(true);
    void refreshHistory();
  };

  const closeHistory = () => {
    setIsHistoryOpen(false);
  };

  const loadHistoryItem = (item: VideoHistoryItem) => {
    closeHistory();
    void loadVideoFromUrl(item.url);
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
            fs: 0,
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

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsVideoFullscreen(document.fullscreenElement === videoShellRef.current);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsCinemaMode(false);
        setIsUrlModalOpen(false);
        setIsHistoryOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const seekToSegment = useCallback((index: number) => {
    const segment = segments[index];

    if (!segment) {
      return;
    }

    playerRef.current?.seekTo(segment.startMs / 1000, true);
    setCurrentTimeMs(segment.startMs);
    if (loopCurrent) {
      setLoopSegmentIndex(index);
      playerRef.current?.playVideo();
      setIsPlaying(true);
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

    const nextIndex = displaySegmentIndex;
    const nextSegment = segments[nextIndex];

    if (!nextSegment) {
      return;
    }

    setLoopSegmentIndex(nextIndex);
    setLoopCurrent(true);
    playerRef.current?.seekTo(nextSegment.startMs / 1000, true);
    playerRef.current?.playVideo();
    setCurrentTimeMs(nextSegment.startMs);
    setIsPlaying(true);
  };

  const changePlaybackRate = (rate: number) => {
    setPlaybackRate(rate);
    playerRef.current?.setPlaybackRate(rate);
  };

  const openTranscriptPane = () => {
    setIsTranscriptPaneOpen(true);
  };

  const closeTranscriptPane = () => {
    setIsTranscriptPaneOpen(false);
  };

  const toggleVideoFullscreen = async () => {
    const videoShell = videoShellRef.current;

    if (!videoShell) {
      return;
    }

    if (isCinemaMode) {
      setIsCinemaMode(false);
      return;
    }

    try {
      if (document.fullscreenElement === videoShell) {
        await document.exitFullscreen();
      } else if (document.fullscreenEnabled) {
        await videoShell.requestFullscreen();
        if (document.fullscreenElement !== videoShell) {
          setIsCinemaMode(true);
        }
      } else {
        setIsCinemaMode(true);
      }
    } catch {
      setIsCinemaMode(true);
    }
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

        <div className="topbar-actions">
          <button className="load-button" disabled={loadState === 'loading'} title="载入视频" type="button" onClick={openUrlModal}>
            {loadState === 'loading' ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
            <span>载入</span>
          </button>

          <button className="history-button" title="历史记录" type="button" onClick={openHistory}>
            <History size={18} />
            <span>历史</span>
            {historyItems.length > 0 ? <small>{historyItems.length}</small> : null}
          </button>
        </div>
      </section>

      {isUrlModalOpen ? (
        <div className="url-modal-backdrop" onClick={closeUrlModal}>
          <section className="url-modal" aria-label="载入视频" onClick={(event) => event.stopPropagation()}>
            <header className="url-modal-header">
              <div>
                <h2>载入视频</h2>
                <p>粘贴 YouTube 链接后，会优先读取本地字幕缓存。</p>
              </div>
              <button aria-label="关闭载入窗口" title="关闭载入窗口" type="button" onClick={closeUrlModal}>
                <X size={18} />
              </button>
            </header>

            <form className="url-form url-modal-form" onSubmit={handleSubmit}>
              <label htmlFor="youtube-url">YouTube 链接</label>
              <div className="url-row">
                <input
                  autoFocus
                  id="youtube-url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://www.youtube.com/watch?v=..."
                  type="url"
                />
                <button className="primary-button" disabled={loadState === 'loading'} type="submit">
                  {loadState === 'loading' ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
                  载入视频
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {isHistoryOpen ? (
        <div className="history-modal-backdrop" onClick={closeHistory}>
          <section className="history-modal" aria-label="历史记录" onClick={(event) => event.stopPropagation()}>
            <header className="history-modal-header">
              <div>
                <h2>历史记录</h2>
                <p>{historyItems.length > 0 ? `${historyItems.length} 个视频` : '还没有历史视频'}</p>
              </div>
              <button title="关闭历史记录" type="button" onClick={closeHistory}>
                <X size={18} />
              </button>
            </header>

            <label className="history-search">
              <Search size={17} />
              <input
                value={historyQuery}
                onChange={(event) => setHistoryQuery(event.target.value)}
                placeholder="搜索标题、频道或链接"
                type="search"
              />
            </label>

            <div className="history-modal-list">
              {filteredHistoryItems.length === 0 ? (
                <div className="history-empty">
                  {historyQuery.trim() ? '没有匹配的历史记录' : '载入视频后会出现在这里'}
                </div>
              ) : (
                filteredHistoryItems.map((item) => (
                  <button
                    className={`history-modal-item${item.videoId === videoId ? ' is-active' : ''}`}
                    key={item.url}
                    type="button"
                    onClick={() => loadHistoryItem(item)}
                  >
                    {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" /> : <span className="history-thumb-fallback">YT</span>}
                    <span className="history-modal-copy">
                      <strong>{item.title}</strong>
                      <small>{item.author}</small>
                      <span>{item.url}</span>
                    </span>
                    <span className="history-modal-meta">
                      <small>添加 {formatDateTime(item.createdAt)}</small>
                      <small>观看 {formatDateTime(item.lastOpenedAt)}</small>
                      <small>字幕 {item.translatedCount}/{item.segmentCount}</small>
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      ) : null}

      <section className={`workspace${isTranscriptPaneOpen ? '' : ' transcript-collapsed'}`}>
        <div className="player-pane">
          <div className={`video-shell${isCinemaMode ? ' is-cinema' : ''}`} ref={videoShellRef}>
            {videoId ? (
              <div className="player-frame" ref={playerHostRef} />
            ) : (
              <div className="video-empty">
                <div className="video-empty-badge">YouTube</div>
                <span>等待视频</span>
              </div>
            )}
            {isVideoExpanded && displaySegment ? (
              <div className="video-subtitle-overlay" aria-live="polite">
                <div className="video-subtitle-copy">
                  <strong>{displaySegment.text}</strong>
                  <span>
                    {displaySegment.translation ||
                      (isTranslating ? '正在生成中文翻译...' : '中文翻译会显示在这里')}
                  </span>
                </div>
                <div className="video-subtitle-controls" aria-label="字幕控制">
                  <button title="前一句" disabled={!canUsePlayer || segments.length === 0} onClick={goToPrevious} type="button">
                    <SkipBack size={18} />
                    <span>前一句</span>
                  </button>
                  <button
                    title="循环当前句"
                    aria-pressed={isLoopActive}
                    className={isLoopActive ? 'is-active' : ''}
                    disabled={!canUsePlayer || segments.length === 0}
                    onClick={toggleLoopCurrent}
                    type="button"
                  >
                    <Repeat2 size={18} />
                    <span>循环</span>
                  </button>
                  <button title="后一句" disabled={!canUsePlayer || segments.length === 0} onClick={goToNext} type="button">
                    <SkipForward size={18} />
                    <span>后一句</span>
                  </button>
                </div>
              </div>
            ) : null}
            {isVideoExpanded ? (
              <button className="video-expanded-close" title="退出字幕全屏" onClick={toggleVideoFullscreen} type="button">
                <Minimize2 size={18} />
                <span>退出</span>
              </button>
            ) : null}
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
              <p className="current-english">{displaySegment ? displaySegment.text : video?.title || '载入视频后显示当前字幕'}</p>
              <small className="current-translation">
                {displaySegment?.translation ||
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
                aria-pressed={isLoopActive}
                className={`text-control${isLoopActive ? ' is-active' : ''}`}
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
              <button
                className="text-control"
                title={isVideoExpanded ? '退出字幕全屏' : '字幕全屏'}
                disabled={!videoId}
                onClick={toggleVideoFullscreen}
              >
                {isVideoExpanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                <span>{isVideoExpanded ? '退出' : '全屏'}</span>
              </button>
              {videoId ? (
                <a className="open-youtube" href={buildYoutubeWatchUrl(videoId)} target="_blank" rel="noreferrer" title="打开 YouTube">
                  <ExternalLink size={18} />
                </a>
              ) : null}
              {isTranscriptPaneOpen ? (
                <button className="text-control" title="收起字幕列表" onClick={closeTranscriptPane} type="button">
                  <PanelRightClose size={18} />
                  <span>收起</span>
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {!isTranscriptPaneOpen ? (
          <button className="transcript-rail-toggle" title="展开字幕列表" onClick={openTranscriptPane} type="button">
            <PanelRightOpen size={18} />
            <span>字幕</span>
          </button>
        ) : null}

        {isTranscriptPaneOpen ? (
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
            <div className="pane-actions">
              <button
                title="重新翻译"
                disabled={!videoId || segments.length === 0 || isTranslating}
                onClick={() => videoId && runTranslation(url.trim() || buildYoutubeWatchUrl(videoId), videoId, sourceLang, segments)}
              >
                {isTranslating ? <Loader2 className="spin" size={18} /> : <RotateCcw size={18} />}
              </button>
              <button title="收起字幕列表" onClick={closeTranscriptPane}>
                <PanelRightClose size={18} />
              </button>
            </div>
          </div>

          {error ? <StatusBanner tone="danger" icon={<AlertCircle size={18} />} text={error} /> : null}
          {translateError ? <StatusBanner tone="warning" icon={<Languages size={18} />} text={translateError} /> : null}
          {isTranslating ? <StatusBanner tone="neutral" icon={<Loader2 className="spin" size={18} />} text={translationStatusText} /> : null}
          {loadedFromLibrary ? <StatusBanner tone="success" icon={<Database size={18} />} text="已从本地 SQLite 读取字幕" /> : null}
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
        ) : null}
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

function hasCompleteTranslations(segments: TranscriptSegment[]): boolean {
  return segments.length > 0 && segments.every((segment) => typeof segment.translation === 'string');
}

function formatDateTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '未知';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
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
