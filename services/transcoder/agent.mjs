#!/usr/bin/env node
/**
 * foldergram-transcoder — the agent that runs ffmpeg on behalf of a
 * Foldergram server.
 *
 * The Foldergram server owns the gallery and knows what a derivative should
 * look like. This agent owns the hardware and knows what it can encode.
 * The server sends the recipe, the agent runs it.
 *
 *   POST /v1/transcode
 *     x-foldergram-plans:  base64 of { plans: [{ encoder, args }] }
 *     x-foldergram-label:  a name for the logs
 *     x-foldergram-input-name / x-foldergram-output-name: file names
 *     body: the source file
 *   → 200 with the produced file as the body
 *
 * The plans are ordered by preference. The agent runs the first one its
 * hardware supports and falls through to the next when a plan fails, so a
 * codec the GPU cannot decode still gets encoded by the CPU.
 *
 * The agent has no dependencies: it is a single file that runs on any Node
 * 22 with `node agent.mjs`.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const config = {
  host: process.env.FOLDERGRAM_TRANSCODER_HOST ?? '0.0.0.0',
  port: Number.parseInt(process.env.FOLDERGRAM_TRANSCODER_PORT ?? '8787', 10),
  token: process.env.FOLDERGRAM_TRANSCODER_TOKEN ?? '',
  allowAnonymous: process.env.FOLDERGRAM_TRANSCODER_ALLOW_ANONYMOUS === '1',
  concurrency: Number.parseInt(process.env.FOLDERGRAM_TRANSCODER_CONCURRENCY ?? '2', 10),
  queueLimit: Number.parseInt(process.env.FOLDERGRAM_TRANSCODER_QUEUE ?? '32', 10),
  tempRoot: process.env.FOLDERGRAM_TRANSCODER_TMP ?? '/var/tmp/foldergram-transcoder',
  ffmpeg: process.env.FOLDERGRAM_TRANSCODER_FFMPEG ?? 'ffmpeg',
  timeoutMs: Number.parseInt(process.env.FOLDERGRAM_TRANSCODER_TIMEOUT_MS ?? '1800000', 10),
  maxInputBytes: Number.parseInt(process.env.FOLDERGRAM_TRANSCODER_MAX_INPUT_BYTES ?? '4294967296', 10),
  device: process.env.FOLDERGRAM_TRANSCODER_DEVICE ?? ''
};

if (!config.token && !config.allowAnonymous) {
  console.error('[transcoder] FOLDERGRAM_TRANSCODER_TOKEN is required. Refusing to start.');
  process.exit(1);
}

if (!Number.isFinite(config.concurrency) || config.concurrency < 1) {
  console.error('[transcoder] FOLDERGRAM_TRANSCODER_CONCURRENCY must be at least 1.');
  process.exit(1);
}

/** The VAAPI device, when the host has one. */
const device = config.device || findRenderDevice();

/** What this host can encode. */
const capabilities = {
  device,
  vaapi: false
};

/** Jobs that are waiting for a free slot. */
let queued = 0;
/** Jobs that are running right now. */
let running = 0;
/** The jobs that are waiting for a free slot. */
const pending = [];

const ffmpegVersion = await probeFfmpegVersion();
await probeEncoders();

console.log(
  `[transcoder] listening on ${config.host}:${config.port} | ffmpeg=${ffmpegVersion} | ` +
  `vaapi=${capabilities.vaapi ? device : 'no'} | concurrency=${config.concurrency}`
);

/**
 * A tiny job queue.
 *
 * The agent runs on a box that also does other work, so the number of
 * concurrent encodes is capped. Requests beyond the cap wait in line; a
 * queue that grows past the limit is refused instead of filling the disk.
 */
function acquireSlot() {
  if (running < config.concurrency) {
    running += 1;
    return Promise.resolve();
  }

  if (queued >= config.queueLimit) {
    return Promise.reject(new Error('The transcoder queue is full.'));
  }

  queued += 1;
  return new Promise((resolve) => {
    pending.push(resolve);
  });
}

function releaseSlot() {
  const next = pending.shift();
  if (next) {
    queued -= 1;
    next();
    return;
  }

  running -= 1;
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error('[transcoder] request failed:', error);
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'text/plain' });
    }
    response.end(error instanceof Error ? error.message : 'Internal error');
  });
});

server.listen(config.port, config.host, () => {
  console.log(`[transcoder] ready on http://${config.host}:${config.port}`);
});

async function handle(request, response) {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (request.method === 'GET' && url.pathname === '/health') {
    respondJson(response, 200, {
      ok: true,
      encoder: capabilities.vaapi ? 'vaapi' : 'software',
      device: capabilities.vaapi ? device : '',
      ffmpeg: ffmpegVersion,
      concurrency: config.concurrency,
      running,
      queued
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/transcode') {
    if (!isAuthorized(request)) {
      respondJson(response, 401, { error: 'Unauthorized' });
      return;
    }

    await transcode(request, response);
    return;
  }

  respondJson(response, 404, { error: 'Not found' });
}

function isAuthorized(request) {
  if (config.allowAnonymous && !config.token) {
    return true;
  }

  const header = request.headers.authorization ?? '';
  return header === `Bearer ${config.token}`;
}

async function transcode(request, response) {
  const label = headerValue(request, 'x-foldergram-label') ?? 'job';
  const plans = parsePlans(headerValue(request, 'x-foldergram-plans'));
  const inputName = safeName(headerValue(request, 'x-foldergram-input-name'), 'input');
  const outputName = safeName(headerValue(request, 'x-foldergram-output-name'), 'output');

  if (plans.length === 0) {
    respondJson(response, 400, { error: 'No encoder plan was sent.' });
    return;
  }

  const usable = plans.filter((plan) => supports(plan.encoder));
  if (usable.length === 0) {
    respondJson(response, 400, { error: 'This host cannot run any of the requested encoder plans.' });
    return;
  }

  try {
    await acquireSlot();
  } catch {
    // The client is still sending the source. Let it finish so the answer
    // reaches it instead of a broken connection.
    request.resume();
    respondJson(response, 503, { error: 'The transcoder queue is full.' });
    return;
  }

  const jobRoot = path.join(config.tempRoot, randomUUID());
  const startedAt = Date.now();

  try {
    await fsp.mkdir(jobRoot, { recursive: true });
    const inputPath = path.join(jobRoot, `input-${inputName}`);
    const outputPath = path.join(jobRoot, `output-${outputName}`);

    let bytes;
    try {
      bytes = await writeRequestBody(request, inputPath);
    } catch (error) {
      // The client is still sending the source. Let it finish so the answer
      // reaches it instead of a broken connection.
      request.resume();
      respondJson(response, 413, {
        error: error instanceof Error ? error.message : 'The upload was refused.'
      });
      return;
    }

    console.log(`[transcoder] ${label}: received ${bytes} bytes`);

    let succeeded = null;
    let lastError = '';

    for (const plan of usable) {
      const args = plan.args.map((argument) =>
        argument
          .split('{input}').join(inputPath)
          .split('{output}').join(outputPath)
          .split('{device}').join(device)
      );

      const result = await runFfmpeg(args);
      if (result.ok) {
        succeeded = plan.encoder;
        break;
      }

      lastError = result.error;
      console.warn(`[transcoder] ${label}: the ${plan.encoder} plan failed: ${result.error}`);
    }

    if (!succeeded) {
      respondJson(response, 500, { error: lastError || 'Every encoder plan failed.' });
      return;
    }

    const stats = await fsp.stat(outputPath);
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(stats.size),
      'x-foldergram-encoder': succeeded
    });

    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(outputPath);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(response);
    });

    console.log(
      `[transcoder] ${label}: done in ${Date.now() - startedAt} ms with ${succeeded} ` +
      `(${stats.size} bytes)`
    );
  } finally {
    releaseSlot();
    await fsp.rm(jobRoot, { recursive: true, force: true });
  }
}

/** Run ffmpeg and collect what it says when it fails. */
function runFfmpeg(args) {
  return new Promise((resolve) => {
    const child = spawn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, config.timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 65536) {
        stdout += chunk.toString();
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) {
        stderr += chunk.toString();
      }
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message, stdout, stderr });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, error: '', stdout, stderr });
        return;
      }

      resolve({
        ok: false,
        error: timedOut
          ? `ffmpeg timed out after ${config.timeoutMs} ms`
          : `ffmpeg exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`,
        stdout,
        stderr
      });
    });
  });
}

/** Write the request body to disk and report how many bytes arrived. */
async function writeRequestBody(request, targetPath) {
  let bytes = 0;
  const handle = await fsp.open(targetPath, 'w');

  try {
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > config.maxInputBytes) {
        throw new Error('The uploaded file is larger than this agent accepts.');
      }
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }

  return bytes;
}

/** Read the plans the server sent. */
function parsePlans(header) {
  if (!header) {
    return [];
  }

  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const plans = Array.isArray(decoded?.plans) ? decoded.plans : [];
    return plans
      .filter((plan) => plan && typeof plan.encoder === 'string' && Array.isArray(plan.args))
      .map((plan) => ({
        encoder: plan.encoder === 'vaapi' ? 'vaapi' : 'software',
        args: plan.args.filter((argument) => typeof argument === 'string')
      }));
  } catch {
    return [];
  }
}

/** Whether this host can run a plan. */
function supports(encoder) {
  if (encoder === 'vaapi') {
    return capabilities.vaapi;
  }

  return true;
}

/** The first render node of the host, if there is one. */
function findRenderDevice() {
  const candidates = [];

  try {
    for (const entry of fs.readdirSync('/dev/dri')) {
      if (entry.startsWith('renderD')) {
        candidates.push(path.join('/dev/dri', entry));
      }
    }
  } catch {
    return '';
  }

  candidates.sort();
  return candidates[0] ?? '';
}

/** The version of the ffmpeg the agent runs. */
async function probeFfmpegVersion() {
  const result = await runFfmpeg(['-hide_banner', '-version']);
  const match = /ffmpeg version (\S+)/.exec(result.stdout);
  return match ? match[1] : 'unknown';
}

/** Look for the encoders and filters the VAAPI plan needs. */
async function probeEncoders() {
  if (!device) {
    return;
  }

  const encoders = await runFfmpeg(['-hide_banner', '-encoders']);
  const filters = await runFfmpeg(['-hide_banner', '-filters']);
  const hasEncoder = encoders.ok && /\bh264_vaapi\b/.test(encoders.stdout);
  const hasFilter = filters.ok && /\bscale_vaapi\b/.test(filters.stdout);

  capabilities.vaapi = hasEncoder && hasFilter;
}

function headerValue(request, name) {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' ? value : '';
}

/**
 * Keep only the file name of a path.
 *
 * The name is used to name the temporary files, and the extension tells
 * ffmpeg which container to write.
 */
function safeName(value, fallback) {
  const base = path.basename(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  return base.length > 0 ? base : fallback;
}

function respondJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}
