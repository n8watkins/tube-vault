export type VideoQuality = 'best' | '1080' | '720' | '480' | '360';
export type VideoFormat = 'mp4' | 'webm' | 'mkv';
export type AudioFormat = 'm4a' | 'mp3' | 'wav' | 'opus';

export interface MenuState {
  video: boolean;
  videoQuality: VideoQuality;
  videoFormat: VideoFormat;
  audio: boolean;
  audioFormat: AudioFormat;
  metadata: boolean;
  thumbnail: boolean;
  subtitles: boolean;
}

export const defaultMenuState: MenuState = {
  video: false,        // nothing pre-selected — the user picks what to download
  videoQuality: 'best',
  videoFormat: 'mp4',
  audio: false,
  audioFormat: 'm4a',
  metadata: false,
  thumbnail: false,
  subtitles: false,
};

// ── File naming & folder layout ───────────────────────────────────────────────
export interface NamingOptions {
  titleFiles: boolean;      // <Title>.<ext> vs generic video/audio/thumbnail
  summaryTxt: boolean;      // write <Title>.txt summary beside the files
  categoryFolders: boolean; // insert Most Popular / Latest / Playlist level
  numbering: boolean;       // "001 - " rank prefix on batch folders
  includeId: boolean;       // keep " [videoId]" suffix on folder name
}

export const defaultNaming: NamingOptions = {
  titleFiles: true, summaryTxt: true, categoryFolders: true, numbering: true, includeId: true,
};

// Flat storage keys — each boolean lives individually in chrome.storage.local.
export const NAMING_KEYS: Record<keyof NamingOptions, string> = {
  titleFiles: 'nameTitleFiles',
  summaryTxt: 'nameSummaryTxt',
  categoryFolders: 'nameCategoryFolders',
  numbering: 'nameNumbering',
  includeId: 'nameIncludeId',
};

// ── Channel button ──────────────────────────────────────────────────────────
export type ChannelMode = 'popular_alltime' | 'popular_recent' | 'latest' | 'all';

// How many recent uploads "popular · recent" ranks (must match the helper).
export const RECENT_POOL = 100;

// Editable in the options page; presets for the channel count selector.
export const DEFAULT_CHANNEL_COUNTS = [1, 5, 10, 30];
export const DEFAULT_CHANNEL_COUNT = 1;
