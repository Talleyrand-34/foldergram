# laya-classifier

Tiny Python service that runs on minisforum and canonicalizes MiniMax-M3's
domain suggestions through [laya](https://huggingface.co/convaiinnovations/laya)
before they enter the AI knowledge graph.

## Deploy

```
pip install -r requirements.txt

# One-shot:
LAYA_PORT=4001 python3 server.py

# As a systemd service:
cp laya-classifier.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now laya-classifier
```

First call downloads the model (~30s). After that, ~33 ms per request.

## Endpoints

- `GET /health` — `{ status, model }`
- `POST /canonicalize` — see `server.py` for the request/response shape

## Wire into foldergram

In `/opt/foldergram/server/.env`:

```
LAYA_CLASSIFIER_URL=http://10.0.2.31:4001
```

Leave unset to disable (the plugin falls back to using M3's raw suggestions).
