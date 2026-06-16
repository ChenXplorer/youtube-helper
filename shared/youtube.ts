const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function extractYoutubeVideoId(input: string): string | null {
  const value = input.trim();

  if (YOUTUBE_ID_RE.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean);

    if (host === 'youtu.be') {
      return normalizeVideoId(parts[0]);
    }

    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      if (url.pathname === '/watch') {
        return normalizeVideoId(url.searchParams.get('v'));
      }

      if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) {
        return normalizeVideoId(parts[1]);
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function buildYoutubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function normalizeVideoId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const [videoId] = value.split(/[?&#]/);
  return YOUTUBE_ID_RE.test(videoId) ? videoId : null;
}
