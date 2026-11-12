# foldergram-transcoder

The agent that runs ffmpeg on behalf of a Foldergram server.

Foldergram knows *what* a derivative should look like. The agent knows *what
this machine can encode*. The server sends the recipe, the agent runs it —
with the GPU when the recipe asks for it and with the CPU when it cannot.

The agent is a single file with no dependencies. It runs on any Node 22.

## Why

A Foldergram server that runs in a container has no GPU and a handful of CPU
cores, and every video preview is a full transcode. On the test library
(63 s, 1080×1920 VP9 → 720×1280 H.264) the same job takes:

| where | encoder | one job | three jobs at once |
| --- | --- | --- | --- |
| container host (6 cores) | `libx264` | 49.6 s | 132.7 s |
| minisforum (16 threads) | `libx264` | 7.3 s | 18.4 s |
| minisforum (Radeon 680M) | `h264_vaapi` | 9.0 s | 27.0 s |

So moving the work to the GPU box is worth 5–7× on its own, and the GPU
encoder keeps the CPU free for everything else on that host.

## Install

```bash
install -d /opt/foldergram-transcoder
install -m 0755 agent.mjs /opt/foldergram-transcoder/agent.mjs
install -m 0644 foldergram-transcoder.service /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now foldergram-transcoder
```

The service needs a shared secret. Put a random one in the unit file:

```bash
openssl rand -hex 24
```

```
Environment=FOLDERGRAM_TRANSCODER_TOKEN=<the secret>
```

The same secret goes into the Foldergram server as
`FFMPEG_TRANSCODER_TOKEN`. The agent refuses to start without one.

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `FOLDERGRAM_TRANSCODER_HOST` | `0.0.0.0` | the address the agent listens on |
| `FOLDERGRAM_TRANSCODER_PORT` | `8787` | the port the agent listens on |
| `FOLDERGRAM_TRANSCODER_TOKEN` | — | the shared secret; required |
| `FOLDERGRAM_TRANSCODER_ALLOW_ANONYMOUS` | `0` | `1` runs without a token (tests only) |
| `FOLDERGRAM_TRANSCODER_CONCURRENCY` | `2` | how many encodes run at the same time |
| `FOLDERGRAM_TRANSCODER_QUEUE` | `32` | how many jobs may wait for a slot |
| `FOLDERGRAM_TRANSCODER_TMP` | `/var/tmp/foldergram-transcoder` | where the source and the result are staged |
| `FOLDERGRAM_TRANSCODER_FFMPEG` | `ffmpeg` | the ffmpeg binary to run |
| `FOLDERGRAM_TRANSCODER_TIMEOUT_MS` | `1800000` | how long a single job may take |
| `FOLDERGRAM_TRANSCODER_MAX_INPUT_BYTES` | `4294967296` | the largest source the agent accepts |
| `FOLDERGRAM_TRANSCODER_DEVICE` | auto | the render node to use |

Keep the concurrency low on a host that does other work. The agent stages
the source file and the result on disk, so the temporary directory needs
room for one source plus one result per running job.

## The GPU

The agent looks for the first `/dev/dri/renderD*` node and asks ffmpeg
whether it has `h264_vaapi` and `scale_vaapi`. When both are there, a plan
that asks for `vaapi` runs on the GPU. When they are not, the agent skips
that plan and runs the software one.

```bash
curl -s http://minisforum:8787/health
```

```json
{
  "ok": true,
  "encoder": "vaapi",
  "device": "/dev/dri/renderD128",
  "ffmpeg": "7.1.5-0+deb13u1",
  "concurrency": 2,
  "running": 0,
  "queued": 0
}
```

## The protocol

### `POST /v1/transcode`

| header | meaning |
| --- | --- |
| `authorization: Bearer <token>` | the shared secret |
| `x-foldergram-plans` | base64 of `{ "plans": [{ "encoder": "vaapi", "args": [...] }] }` |
| `x-foldergram-label` | a name for the logs |
| `x-foldergram-input-name` | the file name of the source |
| `x-foldergram-output-name` | the file name of the result; its extension picks the container |

The body is the source file. The answer is the produced file, with
`x-foldergram-encoder` naming the plan that produced it.

The plans are ordered by preference and carry three placeholders:

| placeholder | meaning |
| --- | --- |
| `{input}` | the staged source file |
| `{output}` | the file the encoder writes |
| `{device}` | the render node of this host |

A plan that fails does not fail the job: the agent tries the next plan and
reports which one worked.

### `GET /health`

Answers without a token. It is what the operator — and the Foldergram
server — checks to see whether the agent is there.
