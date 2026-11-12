import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');
const { execFileMock, execFileAsyncMock, storedSettings } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileAsyncMock: vi.fn(),
  storedSettings: { value: null as string | null }
}));

vi.mock('node:child_process', () => ({
  execFile: Object.assign(execFileMock, {
    [PROMISIFY_CUSTOM]: execFileAsyncMock
  })
}));

// The configuration lives in `app_settings`; the tests only need the store.
vi.mock('../src/db/repositories.js', () => ({
  appSettingsRepository: {
    get: async () => storedSettings.value,
    set: async (_key: string, value: string) => {
      storedSettings.value = value;
    },
    remove: async () => {
      storedSettings.value = null;
    }
  }
}));

type TranscoderModule = typeof import('../src/services/transcoder/index.js');
type RemoteModule = typeof import('../src/services/transcoder/remote-transcoder.js');

const PLANS = [
  {
    encoder: 'vaapi' as const,
    args: ['-i', '{input}', '-vf', 'scale_vaapi', '-c:v', 'h264_vaapi', '{output}']
  },
  {
    encoder: 'software' as const,
    args: ['-i', '{input}', '-c:v', 'libx264', '{output}']
  }
];

describe.sequential('remote transcoder', () => {
  let tempRoot = '';
  let transcoder: TranscoderModule;
  let remote: RemoteModule;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-transcoder-'));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    execFileMock.mockReset();
    execFileAsyncMock.mockReset();
    storedSettings.value = null;
  });

  async function importTranscoder(): Promise<void> {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATA_ROOT', path.join(tempRoot, 'data'));
    vi.stubEnv('GALLERY_ROOT', path.join(tempRoot, 'gallery'));
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(tempRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(tempRoot, 'previews'));

    transcoder = await import('../src/services/transcoder/index.js');
    remote = await import('../src/services/transcoder/remote-transcoder.js');
  }

  /** Store a configuration and drop the cached runner. */
  async function configure(
    settings: Partial<Parameters<TranscoderModule['writeTranscoderSettings']>[0]>
  ): Promise<void> {
    transcoder.resetTranscoder();
    await transcoder.writeTranscoderSettings(settings);
  }

  async function writeSource(name = 'clip.mp4'): Promise<string> {
    const sourcePath = path.join(tempRoot, 'gallery', name);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, 'the source file');
    return sourcePath;
  }

  function outputPath(name = 'clip.mp4'): string {
    return path.join(tempRoot, 'previews', name);
  }

  it('sends the recipe to the agent and stores the produced file', async () => {
    await importTranscoder();
    await configure({
      enabled: true,
      url: 'http://agent.local:8787',
      token: 'secret',
      encoder: 'auto',
      operations: ['video-preview'],
      fallback: 'local',
      maxUploadBytes: 1024 * 1024
    });

    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(Buffer.from('the produced file'), { status: 200 });
    });

    const sourcePath = await writeSource();
    const target = outputPath();

    await (await transcoder.getTranscoder()).run({
      plans: PLANS,
      inputPath: sourcePath,
      outputPath: target,
      label: 'video-preview'
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://agent.local:8787/v1/transcode');

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret');
    expect(headers['x-foldergram-label']).toBe('video-preview');
    expect(headers['x-foldergram-input-name']).toBe('clip.mp4');
    expect(headers['x-foldergram-output-name']).toBe('clip.mp4');

    const sent = JSON.parse(
      Buffer.from(headers['x-foldergram-plans'], 'base64').toString('utf8')
    ) as { plans: Array<{ encoder: string }> };
    expect(sent.plans.map((plan) => plan.encoder)).toEqual(['vaapi', 'software']);

    expect(await fs.readFile(target, 'utf8')).toBe('the produced file');
  });

  it('keeps the token out of the configuration the browser sees', async () => {
    await importTranscoder();
    await configure({
      enabled: true,
      url: 'http://agent.local:8787',
      token: 'secret',
      encoder: 'auto',
      operations: ['video-preview'],
      fallback: 'local',
      maxUploadBytes: 1024 * 1024
    });

    const settings = await transcoder.readTranscoderSettings();
    const view = transcoder.toTranscoderSettingsView(settings);

    expect(view.tokenSet).toBe(true);
    expect(JSON.stringify(view)).not.toContain('secret');
  });

  it('keeps the stored token when the write does not mention it', async () => {
    await importTranscoder();
    await configure({
      enabled: true,
      url: 'http://agent.local:8787',
      token: 'secret',
      encoder: 'auto',
      operations: ['video-preview'],
      fallback: 'local',
      maxUploadBytes: 1024 * 1024
    });

    await transcoder.writeTranscoderSettings({ enabled: false });
    const settings = await transcoder.readTranscoderSettings();

    expect(settings.token).toBe('secret');
    expect(settings.enabled).toBe(false);
  });

  it('reports what the agent can do', async () => {
    await importTranscoder();
    await configure({
      enabled: true,
      url: 'http://agent.local:8787',
      encoder: 'auto',
      operations: ['video-preview'],
      fallback: 'local',
      maxUploadBytes: 1024 * 1024
    });

    vi.stubGlobal('fetch', async (url: string) => {
      expect(String(url)).toBe('http://agent.local:8787/health');
      return new Response(
        JSON.stringify({ ok: true, encoder: 'vaapi', device: '/dev/dri/renderD128', ffmpeg: '7.1.5' }),
        { status: 200 }
      );
    });

    const status = await transcoder.getTranscoderStatus();

    expect(status.reachable).toBe(true);
    expect(status.encoder).toBe('vaapi');
    expect(status.device).toBe('/dev/dri/renderD128');
    expect(status.ffmpeg).toBe('7.1.5');
  });

  it('says so when the agent cannot be reached', async () => {
    await importTranscoder();
    await configure({
      enabled: true,
      url: 'http://agent.local:8787',
      encoder: 'auto',
      operations: ['video-preview'],
      fallback: 'local',
      maxUploadBytes: 1024 * 1024
    });

    vi.stubGlobal('fetch', async () => {
      throw new Error('connection refused');
    });

    const status = await transcoder.getTranscoderStatus();

    expect(status.reachable).toBe(false);
    expect(status.error).toContain('connection refused');
  });

  it('falls back to the local ffmpeg when the agent fails', async () => {
    await importTranscoder();
    await configure({
      enabled: true,
      url: 'http://agent.local:8787',
      token: 'secret',
      encoder: 'auto',
      operations: ['video-preview'],
      fallback: 'local',
      maxUploadBytes: 1024 * 1024
    });

    vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });

    const sourcePath = await writeSource();
    const target = outputPath();

    await (await transcoder.getTranscoder()).run({
      plans: PLANS,
      inputPath: sourcePath,
      outputPath: target,
      label: 'video-preview'
    });

    const ffmpegCalls = execFileAsyncMock.mock.calls.filter(([command]) => command === 'ffmpeg');
    expect(ffmpegCalls).toHaveLength(1);
    expect(ffmpegCalls[0]?.[1]).toContain(sourcePath);
    expect(ffmpegCalls[0]?.[1]).toContain(target);
  });

  it('keeps the job local when the fallback is turned off', async () => {
    await importTranscoder();
    await configure({
      enabled: true,
      url: 'http://agent.local:8787',
      token: 'secret',
      encoder: 'auto',
      operations: ['video-preview'],
      fallback: 'off',
      maxUploadBytes: 1024 * 1024
    });

    vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));

    const sourcePath = await writeSource();

    await expect(
      (await transcoder.getTranscoder()).run({
        plans: PLANS,
        inputPath: sourcePath,
        outputPath: outputPath(),
        label: 'video-preview'
      })
    ).rejects.toThrow(/500/);

    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it('keeps everything local when the transcoder is off', async () => {
    await importTranscoder();
    await configure({
      enabled: false,
      url: 'http://agent.local:8787',
      token: 'secret',
      encoder: 'auto',
      operations: ['*'],
      fallback: 'local',
      maxUploadBytes: 1024 * 1024
    });

    const fetchMock = vi.fn(async () => new Response('unused', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });

    const sourcePath = await writeSource();

    await (await transcoder.getTranscoder()).run({
      plans: PLANS,
      inputPath: sourcePath,
      outputPath: outputPath(),
      label: 'video-preview'
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
  });

  it('never ships a source that is larger than the upload limit', async () => {
    await importTranscoder();
    await configure({
      enabled: true,
      url: 'http://agent.local:8787',
      token: 'secret',
      encoder: 'auto',
      operations: ['video-preview'],
      fallback: 'local',
      maxUploadBytes: 4
    });

    const fetchMock = vi.fn(async () => new Response('unused', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });

    const sourcePath = await writeSource('big.mp4');

    await (await transcoder.getTranscoder()).run({
      plans: PLANS,
      inputPath: sourcePath,
      outputPath: outputPath('big.mp4'),
      label: 'video-preview'
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a derivative on the host when its kind is not on the list', async () => {
    await importTranscoder();
    await configure({
      enabled: true,
      url: 'http://agent.local:8787',
      token: 'secret',
      encoder: 'auto',
      operations: ['video-preview'],
      fallback: 'local',
      maxUploadBytes: 1024 * 1024
    });

    const fetchMock = vi.fn(async () => new Response('unused', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });

    const sourcePath = await writeSource();

    await (await transcoder.getTranscoder()).run({
      plans: PLANS,
      inputPath: sourcePath,
      outputPath: outputPath(),
      label: 'video-thumbnail'
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
  });

  it('sends every kind when the list says so', async () => {
    await importTranscoder();
    await configure({
      enabled: true,
      url: 'http://agent.local:8787',
      token: 'secret',
      encoder: 'auto',
      operations: ['*'],
      fallback: 'local',
      maxUploadBytes: 1024 * 1024
    });

    const fetchMock = vi.fn(async () => new Response(Buffer.from('done'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const sourcePath = await writeSource();

    await (await transcoder.getTranscoder()).run({
      plans: PLANS,
      inputPath: sourcePath,
      outputPath: outputPath(),
      label: 'video-thumbnail'
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('narrows the plans to the preferred encoder', async () => {
    await importTranscoder();
    await configure({
      enabled: true,
      url: 'http://agent.local:8787',
      token: 'secret',
      encoder: 'software',
      operations: ['video-preview'],
      fallback: 'local',
      maxUploadBytes: 1024 * 1024
    });

    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(Buffer.from('done'), { status: 200 });
    });

    const sourcePath = await writeSource();

    await (await transcoder.getTranscoder()).run({
      plans: PLANS,
      inputPath: sourcePath,
      outputPath: outputPath(),
      label: 'video-preview'
    });

    const headers = calls[0]?.init.headers as Record<string, string>;
    const sent = JSON.parse(
      Buffer.from(headers['x-foldergram-plans'], 'base64').toString('utf8')
    ) as { plans: Array<{ encoder: string }> };

    expect(sent.plans.map((plan) => plan.encoder)).toEqual(['software']);
  });

  it('keeps every plan when the preference is auto', () => {
    expect(remote.selectPlans(PLANS, 'auto')).toHaveLength(2);
    expect(remote.selectPlans(PLANS, 'vaapi').map((plan) => plan.encoder)).toEqual(['vaapi']);
    expect(remote.selectPlans(PLANS, 'software').map((plan) => plan.encoder)).toEqual(['software']);
  });
});
