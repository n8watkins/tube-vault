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
}

export const defaultMenuState: MenuState = {
  video: true,
  videoQuality: 'best',
  videoFormat: 'mp4',
  audio: false,
  audioFormat: 'm4a',
  metadata: false,
  thumbnail: false,
};
