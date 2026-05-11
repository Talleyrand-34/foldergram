import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import sharp from 'sharp';

import type { ImageExifData, MediaType, PlaybackStrategy } from '../types/models.js';
import { appConfig } from '../config/env.js';
import { extractImageExif, normalizeTakenAtValue } from '../utils/exif-utils.js';
import {
  PREVIEW_MAX_WIDTH,
  THUMBNAIL_SIZE,
  getMediaTypeFromExtension,
  getPreviewRelativePath,
  getThumbnailRelativePath
} from '../utils/image-utils.js';
import { safeJoin } from '../utils/path-utils.js';

const execFileAsync = promisify(execFile);
const DIRECT_VIDEO_PLAYBACK_ALLOWED_AUDIO_CODECS = new Set(['aac']);
const DIRECT_VIDEO_PLAYBACK_ALLOWED_PIXEL_FORMATS = new Set(['yuv420p']);
export const VIDEO_PREVIEW_MAX_LONG_EDGE = 1280;
export const VIDEO_PREVIEW_MAX_SHORT_EDGE = 720;

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  tags?: {
    creation_time?: string;
    rotate?: string;
  };
  side_data_list?: Array<{
    rotation?: number;
  }>;
}

interface FfprobeFormat {
  duration?: string;
  format_name?: string;
  tags?: {
    creation_time?: string;
  };
}

interface FfprobePayload {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

export interface MediaMetadata {
  width: number;
  height: number;
  displayOrientation?: number | null;
  takenAt: number | null;
  exif?: ImageExifData | null;
  durationMs: number | null;
  mediaType: MediaType;
  playbackStrategy: PlaybackStrategy;
  isAnimated: boolean;
}

export interface DerivativeResult extends MediaMetadata {
  thumbnailPath: string;
  previewPath: string;
  generatedThumbnail: boolean;
  generatedPreview: boolean;
}

export interface ThumbnailDerivativeResult {
  thumbnailPath: string;
  generatedThumbnail: boolean;
}

export interface DerivativePathOverrides {
  thumbnailPath?: string;
  previewPath?: string;
}

interface ReadMediaMetadataOptions {
  fileSize?: number;
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runBinary(command: string, args: string[]): Promise<void> {
  await execFileAsync(command, args, {
    maxBuffer: 8 * 1024 * 1024
  });
}

async function readVideoProbe(sourcePath: string): Promise<FfprobePayload> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration,format_name:format_tags=creation_time:stream=codec_type,codec_name,width,height,pix_fmt:stream_tags=creation_time,rotate:stream_side_data=rotation',
      '-of',
      'json',
      sourcePath
    ],
    {
      maxBuffer: 2 * 1024 * 1024
    }
  );

  return JSON.parse(stdout) as FfprobePayload;
}

function normalizeVideoRotation(rotation: number | string | null | undefined): number {
  if (rotation === null || rotation === undefined || rotation === '') {
    return 0;
  }

  const parsedRotation = typeof rotation === 'number' ? rotation : Number.parseFloat(rotation);
  if (!Number.isFinite(parsedRotation)) {
    return 0;
  }

  return ((Math.round(parsedRotation) % 360) + 360) % 360;
}

function resolveVideoDisplayDimensions(videoStream: FfprobeStream | undefined): Pick<MediaMetadata, 'width' | 'height'> {
  const width = videoStream?.width ?? THUMBNAIL_SIZE;
  const height = videoStream?.height ?? THUMBNAIL_SIZE;
  const rotation =
    videoStream?.side_data_list?.find((sideData) => typeof sideData.rotation === 'number')?.rotation
    ?? videoStream?.tags?.rotate;
  const normalizedRotation = normalizeVideoRotation(rotation);

  if (normalizedRotation % 180 === 90) {
    return {
      width: height,
      height: width
    };
  }

  return {
    width,
    height
  };
}

function normalizeImageOrientation(orientation: number | null | undefined): number | null {
  if (typeof orientation !== 'number' || !Number.isInteger(orientation) || orientation < 1 || orientation > 8) {
    return null;
  }

  return orientation;
}

function resolveImageDisplayDimensions(
  metadata: sharp.Metadata,
  displayOrientation: number
): Pick<MediaMetadata, 'width' | 'height'> {
  const width = metadata.width ?? THUMBNAIL_SIZE;
  const height = metadata.height ?? THUMBNAIL_SIZE;

  if (displayOrientation >= 5) {
    return {
      width: height,
      height: width
    };
  }

  return {
    width,
    height
  };
}

async function readImageMetadata(sourcePath: string): Promise<MediaMetadata> {
  const [metadata, imageExif] = await Promise.all([
    sharp(sourcePath, { animated: false }).metadata(),
    extractImageExif(sourcePath)
  ]);
  const displayOrientation = normalizeImageOrientation(metadata.orientation) ?? 1;
  const displayDimensions = resolveImageDisplayDimensions(metadata, displayOrientation);

  return {
    width: displayDimensions.width,
    height: displayDimensions.height,
    displayOrientation,
    takenAt: imageExif.takenAt,
    exif: imageExif.exif,
    durationMs: null,
    mediaType: 'image',
    playbackStrategy: 'preview',
    isAnimated: (metadata.pages ?? 1) > 1
  };
}

async function resolveVideoPlaybackStrategy(
  sourcePath: string,
  payload: FfprobePayload
): Promise<PlaybackStrategy> {
  if (path.extname(sourcePath).toLowerCase() !== '.mp4') {
    return 'preview';
  }

  const videoStream = payload.streams?.find((stream) => stream.codec_type === 'video');
  const audioStream = payload.streams?.find((stream) => stream.codec_type === 'audio');
  const formatName = payload.format?.format_name?.toLowerCase() ?? '';

  if (!videoStream) {
    return 'preview';
  }

  const hasCompatibleContainer = formatName.includes('mp4');
  const hasCompatibleVideoCodec = videoStream.codec_name === 'h264';
  const hasCompatiblePixelFormat = DIRECT_VIDEO_PLAYBACK_ALLOWED_PIXEL_FORMATS.has(videoStream.pix_fmt ?? '');
  const hasCompatibleAudioCodec = !audioStream || DIRECT_VIDEO_PLAYBACK_ALLOWED_AUDIO_CODECS.has(audioStream.codec_name ?? '');

  return hasCompatibleContainer &&
    hasCompatibleVideoCodec &&
    hasCompatiblePixelFormat &&
    hasCompatibleAudioCodec
    ? 'original'
    : 'preview';
}

async function readVideoMetadata(sourcePath: string, options: ReadMediaMetadataOptions = {}): Promise<MediaMetadata> {
  const payload = await readVideoProbe(sourcePath);
  const videoStream = payload.streams?.find((stream) => stream.codec_type === 'video');
  const durationSeconds = payload.format?.duration ? Number.parseFloat(payload.format.duration) : Number.NaN;
  const durationMs = Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : null;
  const takenAt = normalizeTakenAtValue(videoStream?.tags?.creation_time ?? payload.format?.tags?.creation_time ?? null);
  const displayDimensions = resolveVideoDisplayDimensions(videoStream);

  return {
    width: displayDimensions.width,
    height: displayDimensions.height,
    takenAt,
    exif: null,
    durationMs,
    mediaType: 'video',
    playbackStrategy: await resolveVideoPlaybackStrategy(sourcePath, payload),
    isAnimated: false
  };
}

export async function readMediaMetadata(
  sourcePath: string,
  mediaType: MediaType,
  options: ReadMediaMetadataOptions = {}
): Promise<MediaMetadata> {
  return mediaType === 'video' ? readVideoMetadata(sourcePath, options) : readImageMetadata(sourcePath);
}

async function writeImageThumbnail(sourcePath: string, thumbnailAbsolutePath: string): Promise<void> {
  await ensureParentDirectory(thumbnailAbsolutePath);
  await sharp(sourcePath, { animated: false })
    .rotate()
    .resize({
      width: THUMBNAIL_SIZE,
      withoutEnlargement: true
    })
    .webp({ quality: 82, effort: 4 })
    .toFile(thumbnailAbsolutePath);
}

export async function writeImagePreview(sourcePath: string, previewAbsolutePath: string): Promise<void> {
  await ensureParentDirectory(previewAbsolutePath);
  await sharp(sourcePath, { animated: true })
    .rotate()
    .resize({
      width: PREVIEW_MAX_WIDTH,
      withoutEnlargement: true
    })
    .webp({ quality: 86, effort: 4 })
    .toFile(previewAbsolutePath);
}

async function writeVideoThumbnail(sourcePath: string, thumbnailAbsolutePath: string): Promise<void> {
  await ensureParentDirectory(thumbnailAbsolutePath);
  await runBinary('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    sourcePath,
    '-vf',
    `thumbnail,scale='min(${THUMBNAIL_SIZE},iw)':-2:flags=lanczos`,
    '-frames:v',
    '1',
    '-c:v',
    'libwebp',
    '-quality',
    '82',
    '-compression_level',
    '4',
    thumbnailAbsolutePath
  ]);
}

export async function writeVideoPreview(sourcePath: string, previewAbsolutePath: string): Promise<void> {
  await ensureParentDirectory(previewAbsolutePath);
  // Landscape videos target up to 1280x720. Portrait and square videos cap their
  // short edge at 720 while preserving aspect ratio. Output dimensions are rounded
  // to even numbers for yuv420p compatibility.
  const scaleFilter =
    `scale=` +
    `'trunc(if(gt(iw,ih),min(${VIDEO_PREVIEW_MAX_LONG_EDGE},iw),min(${VIDEO_PREVIEW_MAX_SHORT_EDGE},iw))/2)*2':` +
    `'trunc(if(gt(iw,ih),min(${VIDEO_PREVIEW_MAX_LONG_EDGE},iw)*ih/iw,min(${VIDEO_PREVIEW_MAX_SHORT_EDGE},iw)*ih/iw)/2)*2':flags=lanczos`;
  await runBinary('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    sourcePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-vf',
    scaleFilter,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '24',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    previewAbsolutePath
  ]);
}

async function generateImageDerivatives(
  sourcePath: string,
  thumbnailAbsolutePath: string,
  previewAbsolutePath: string,
  force: boolean
): Promise<Pick<DerivativeResult, 'generatedThumbnail' | 'generatedPreview'>> {
  const [shouldWriteThumbnail, shouldWritePreview] = await Promise.all([
    force ? Promise.resolve(true) : fileExists(thumbnailAbsolutePath).then((exists) => !exists),
    force ? Promise.resolve(true) : fileExists(previewAbsolutePath).then((exists) => !exists)
  ]);

  await Promise.all([
    shouldWriteThumbnail ? writeImageThumbnail(sourcePath, thumbnailAbsolutePath) : Promise.resolve(),
    shouldWritePreview ? writeImagePreview(sourcePath, previewAbsolutePath) : Promise.resolve()
  ]);

  return {
    generatedThumbnail: shouldWriteThumbnail,
    generatedPreview: shouldWritePreview
  };
}

async function generateVideoDerivatives(
  sourcePath: string,
  thumbnailAbsolutePath: string,
  previewAbsolutePath: string,
  force: boolean
): Promise<Pick<DerivativeResult, 'generatedThumbnail' | 'generatedPreview'>> {
  const [shouldWriteThumbnail, shouldWritePreview] = await Promise.all([
    force ? Promise.resolve(true) : fileExists(thumbnailAbsolutePath).then((exists) => !exists),
    force ? Promise.resolve(true) : fileExists(previewAbsolutePath).then((exists) => !exists)
  ]);

  await Promise.all([
    shouldWriteThumbnail ? writeVideoThumbnail(sourcePath, thumbnailAbsolutePath) : Promise.resolve(),
    shouldWritePreview ? writeVideoPreview(sourcePath, previewAbsolutePath) : Promise.resolve()
  ]);

  return {
    generatedThumbnail: shouldWriteThumbnail,
    generatedPreview: shouldWritePreview
  };
}

export async function generateThumbnailDerivative(
  sourcePath: string,
  relativePath: string,
  force = false,
  overrides: DerivativePathOverrides = {}
): Promise<ThumbnailDerivativeResult> {
  const mediaType = getMediaTypeFromExtension(path.extname(relativePath));
  const thumbnailPath = overrides.thumbnailPath ?? getThumbnailRelativePath(relativePath);
  const thumbnailAbsolutePath = safeJoin(appConfig.thumbnailsDir, thumbnailPath);
  const shouldWriteThumbnail = force || !(await fileExists(thumbnailAbsolutePath));

  if (shouldWriteThumbnail) {
    if (mediaType === 'video') {
      await writeVideoThumbnail(sourcePath, thumbnailAbsolutePath);
    } else {
      await writeImageThumbnail(sourcePath, thumbnailAbsolutePath);
    }
  }

  return {
    thumbnailPath,
    generatedThumbnail: shouldWriteThumbnail
  };
}

export async function generateDerivatives(
  sourcePath: string,
  relativePath: string,
  force = false,
  overrides: DerivativePathOverrides = {}
): Promise<DerivativeResult> {
  const mediaType = getMediaTypeFromExtension(path.extname(relativePath));
  const thumbnailPath = overrides.thumbnailPath ?? getThumbnailRelativePath(relativePath);
  const previewPath = overrides.previewPath ?? getPreviewRelativePath(relativePath, mediaType);
  const thumbnailAbsolutePath = safeJoin(appConfig.thumbnailsDir, thumbnailPath);
  const previewAbsolutePath = safeJoin(appConfig.previewsDir, previewPath);
  const metadata = await readMediaMetadata(sourcePath, mediaType);
  const generated =
    mediaType === 'video'
      ? await generateVideoDerivatives(sourcePath, thumbnailAbsolutePath, previewAbsolutePath, force)
      : await generateImageDerivatives(sourcePath, thumbnailAbsolutePath, previewAbsolutePath, force);

  return {
    ...metadata,
    thumbnailPath,
    previewPath,
    generatedThumbnail: generated.generatedThumbnail,
    generatedPreview: generated.generatedPreview
  };
}
