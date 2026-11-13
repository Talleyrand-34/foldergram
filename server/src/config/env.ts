import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

import { parseExcludedFolderRulesFromEnv } from '../utils/excluded-folder-rules.js';
import { getRelativePathWithinRoot, isSameOrWithinPath, normalizePath } from '../utils/path-utils.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(moduleDirectory, '../../..');

dotenv.config({ path: path.join(repositoryRoot, '.env') });

const envSchema = z.object({
  SERVER_HOST: z.string().default('0.0.0.0'),
  SERVER_PORT: z.coerce.number().int().positive().optional(),
  DEV_SERVER_PORT: z.coerce.number().int().positive().optional(),
  DEV_CLIENT_PORT: z.coerce.number().int().positive().optional(),
  DATA_ROOT: z.string().default('./data'),
  DATA_DIR: z.string().optional(),
  GALLERY_ROOT: z.string().optional(),
  DB_DIR: z.string().optional(),
  THUMBNAILS_DIR: z.string().optional(),
  PREVIEWS_DIR: z.string().optional(),
  LOG_VERBOSE: z.string().optional(),
  SCAN_MEDIA_ERROR_MODE: z.enum(['skip', 'fail']).default('skip'),
  SCAN_FOLDER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  SCAN_DISCOVERY_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  SCAN_DERIVATIVE_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  PUBLIC_DEMO_MODE: z.string().optional(),
  CSRF_TRUSTED_ORIGINS: z.string().optional(),
  GALLERY_EXCLUDED_FOLDERS: z.string().optional(),
  IMAGE_DETAIL_SOURCE: z.enum(['preview', 'original']).default('preview'),
  DERIVATIVE_MODE: z.enum(['eager', 'lazy']).default('eager'),
  FFMPEG_TRANSCODER_MODE: z.enum(['local', 'remote', 'auto']).default('local'),
  FFMPEG_TRANSCODER_URL: z.string().optional(),
  FFMPEG_TRANSCODER_TOKEN: z.string().optional(),
  FFMPEG_TRANSCODER_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(900_000),
  FFMPEG_TRANSCODER_ENCODER: z.enum(['auto', 'vaapi', 'software']).default('auto'),
  FFMPEG_TRANSCODER_OPERATIONS: z.string().optional(),
  FFMPEG_TRANSCODER_FALLBACK: z.enum(['local', 'off']).default('local'),
  FFMPEG_TRANSCODER_MAX_UPLOAD_BYTES: z.coerce.number().int().min(0).default(536_870_912),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DB_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  DATABASE_URL: z.string().optional(),
  LOG_SLOW_QUERY_MS: z.coerce.number().int().min(0).default(200),
  REELS_CANDIDATE_LIMIT: z.coerce.number().int().min(100).default(2000),
  VALKEY_URL: z.string().optional(),
  CACHE_KEY_PREFIX: z.string().default('foldergram:'),
  PYROSCOPE_SERVER_ADDRESS: z.string().optional(),
  PYROSCOPE_APPLICATION_NAME: z.string().optional(),
  PYROSCOPE_FLUSH_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
  PYROSCOPE_WALL_SAMPLING_DURATION_MS: z.coerce.number().int().min(1000).default(60_000),
  PYROSCOPE_WALL_SAMPLING_INTERVAL_MICROS: z.coerce.number().int().min(1000).default(10_000),
  PYROSCOPE_HEAP_PROFILING: z.string().optional(),
  PYROSCOPE_BASIC_AUTH_USER: z.string().optional(),
  PYROSCOPE_BASIC_AUTH_PASSWORD: z.string().optional(),
  PYROSCOPE_TENANT_ID: z.string().optional()
});

const parsed = envSchema.parse(process.env);

if (parsed.DB_DRIVER === 'postgres' && !parsed.DATABASE_URL) {
  throw new Error('DATABASE_URL is required when DB_DRIVER=postgres');
}
const isProduction = parsed.NODE_ENV === 'production';
const devClientPort = parsed.DEV_CLIENT_PORT ?? 4141;
const serverPort = isProduction
  ? parsed.SERVER_PORT ?? 4141
  : parsed.DEV_SERVER_PORT ?? 4140;
const devClientPorts = Array.from({ length: 4 }, (_, index) => devClientPort + index);

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(repositoryRoot, value);
}

function resolveConfiguredPath(value: string | null | undefined, fallbackAbsolutePath: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return resolveFromRoot(value);
  }

  return fallbackAbsolutePath;
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * The derivative kinds that may leave the host.
 *
 * `*` means all of them. The default is the video preview: it is a full
 * transcode and the one that hurts on a host without a GPU. A thumbnail is
 * a single frame, so shipping the whole source to another machine costs
 * more than the frame is worth.
 */
function parseTranscoderOperations(value: string | undefined): string[] {
  const entries = (value ?? 'video-preview')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return entries.length > 0 ? uniq(entries) : ['video-preview'];
}

function parseBooleanFlag(value: string | undefined): boolean {
  return typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim());
}

function normalizeConfiguredOrigin(origin: string): string {
  let parsedOrigin: URL;

  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error(`Invalid CSRF_TRUSTED_ORIGINS entry: ${origin}`);
  }

  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    throw new Error(`Invalid CSRF_TRUSTED_ORIGINS entry: ${origin}`);
  }

  return parsedOrigin.origin;
}

function parseConfiguredOrigins(value: string | undefined): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  return uniq(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => normalizeConfiguredOrigin(entry))
  );
}

const dataRoot = resolveConfiguredPath(parsed.DATA_ROOT ?? parsed.DATA_DIR, resolveFromRoot('./data'));
const galleryRoot = resolveConfiguredPath(parsed.GALLERY_ROOT, path.join(dataRoot, 'gallery'));
const dbDir = resolveConfiguredPath(parsed.DB_DIR, path.join(dataRoot, 'db'));
const geodataDir = path.join(dataRoot, 'geodata');
const thumbnailsDir = resolveConfiguredPath(parsed.THUMBNAILS_DIR, path.join(dataRoot, 'thumbnails'));
const previewsDir = resolveConfiguredPath(parsed.PREVIEWS_DIR, path.join(dataRoot, 'previews'));
const scanErrorReportDir = path.join(dataRoot, 'scan-errors');
const logVerbose = parseBooleanFlag(parsed.LOG_VERBOSE);
const publicDemoMode = parseBooleanFlag(parsed.PUBLIC_DEMO_MODE);
const csrfTrustedOrigins = parseConfiguredOrigins(parsed.CSRF_TRUSTED_ORIGINS);
const galleryExcludedFolders = parseExcludedFolderRulesFromEnv(parsed.GALLERY_EXCLUDED_FOLDERS);

const ffmpegTranscoderUrl = parsed.FFMPEG_TRANSCODER_URL?.trim() || undefined;

if (parsed.FFMPEG_TRANSCODER_MODE === 'remote' && !ffmpegTranscoderUrl) {
  throw new Error('Invalid storage configuration: FFMPEG_TRANSCODER_URL is required when FFMPEG_TRANSCODER_MODE=remote.');
}

const derivativeDirectoriesOverlap =
  isSameOrWithinPath(thumbnailsDir, previewsDir) || isSameOrWithinPath(previewsDir, thumbnailsDir);

if (derivativeDirectoriesOverlap) {
  throw new Error('Invalid storage configuration: THUMBNAILS_DIR and PREVIEWS_DIR must point to separate non-overlapping directories.');
}

const scanErrorReportDirectoryOverlapsServedMedia =
  isSameOrWithinPath(scanErrorReportDir, thumbnailsDir) ||
  isSameOrWithinPath(thumbnailsDir, scanErrorReportDir) ||
  isSameOrWithinPath(scanErrorReportDir, previewsDir) ||
  isSameOrWithinPath(previewsDir, scanErrorReportDir);

if (scanErrorReportDirectoryOverlapsServedMedia) {
  throw new Error('Invalid storage configuration: scan error reports must not overlap THUMBNAILS_DIR or PREVIEWS_DIR.');
}

if (isSameOrWithinPath(thumbnailsDir, galleryRoot)) {
  throw new Error('Invalid storage configuration: THUMBNAILS_DIR cannot contain GALLERY_ROOT.');
}

if (isSameOrWithinPath(previewsDir, galleryRoot)) {
  throw new Error('Invalid storage configuration: PREVIEWS_DIR cannot contain GALLERY_ROOT.');
}

const managedGalleryRelativeIgnores = uniq(
  [dbDir, thumbnailsDir, previewsDir, scanErrorReportDir]
    .map((directoryPath) => getRelativePathWithinRoot(galleryRoot, directoryPath))
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => normalizePath(value))
);

export const appConfig = {
  host: parsed.SERVER_HOST,
  port: serverPort,
  devClientPort,
  devClientPorts,
  nodeEnv: parsed.NODE_ENV,
  isDevelopment: parsed.NODE_ENV === 'development',
  dataRoot,
  galleryRoot,
  dbDir,
  geodataDir,
  thumbnailsDir,
  previewsDir,
  scanErrorReportDir,
  managedGalleryRelativeIgnores,
  galleryExcludedFolders,
  logVerbose,
  scanMediaErrorMode: parsed.SCAN_MEDIA_ERROR_MODE,
  publicDemoMode,
  csrfTrustedOrigins,
  scanFolderConcurrency: parsed.SCAN_FOLDER_CONCURRENCY,
  scanDiscoveryConcurrency: parsed.SCAN_DISCOVERY_CONCURRENCY,
  scanDerivativeConcurrency: parsed.SCAN_DERIVATIVE_CONCURRENCY,
  databasePath: path.join(dbDir, 'gallery.sqlite'),
  geodataPath: path.join(geodataDir, 'geonames-cities500.sqlite'),
  geodataMetadataPath: path.join(geodataDir, 'geonames-cities500.meta.json'),
  imageDetailSource: parsed.IMAGE_DETAIL_SOURCE,
  derivativeMode: parsed.DERIVATIVE_MODE,
  ffmpegTranscoderMode: parsed.FFMPEG_TRANSCODER_MODE,
  ffmpegTranscoderUrl,
  ffmpegTranscoderToken: parsed.FFMPEG_TRANSCODER_TOKEN?.trim() || undefined,
  ffmpegTranscoderTimeoutMs: parsed.FFMPEG_TRANSCODER_TIMEOUT_MS,
  ffmpegTranscoderEncoder: parsed.FFMPEG_TRANSCODER_ENCODER,
  ffmpegTranscoderOperations: parseTranscoderOperations(parsed.FFMPEG_TRANSCODER_OPERATIONS),
  ffmpegTranscoderFallback: parsed.FFMPEG_TRANSCODER_FALLBACK,
  ffmpegTranscoderMaxUploadBytes: parsed.FFMPEG_TRANSCODER_MAX_UPLOAD_BYTES,
  dbDriver: parsed.DB_DRIVER,
  databaseUrl: parsed.DATABASE_URL,
  logSlowQueryMs: parsed.LOG_SLOW_QUERY_MS,
  reelsCandidateLimit: parsed.REELS_CANDIDATE_LIMIT,
  valkeyUrl: parsed.VALKEY_URL?.trim() || undefined,
  cacheKeyPrefix: parsed.CACHE_KEY_PREFIX,
  pyroscope: {
    // Without a server address there is nowhere to send the profiles to, so
    // the profiling stays off.
    serverAddress: parsed.PYROSCOPE_SERVER_ADDRESS?.trim() || null,
    applicationName: parsed.PYROSCOPE_APPLICATION_NAME?.trim() || 'foldergram',
    flushIntervalMs: parsed.PYROSCOPE_FLUSH_INTERVAL_MS,
    wallSamplingDurationMs: parsed.PYROSCOPE_WALL_SAMPLING_DURATION_MS,
    wallSamplingIntervalMicros: parsed.PYROSCOPE_WALL_SAMPLING_INTERVAL_MICROS,
    // The allocation profiler is expensive, so it is opt in.
    heapEnabled: parseBooleanFlag(parsed.PYROSCOPE_HEAP_PROFILING),
    basicAuthUser: parsed.PYROSCOPE_BASIC_AUTH_USER?.trim() || undefined,
    basicAuthPassword: parsed.PYROSCOPE_BASIC_AUTH_PASSWORD || undefined,
    tenantId: parsed.PYROSCOPE_TENANT_ID?.trim() || undefined
  }
};
