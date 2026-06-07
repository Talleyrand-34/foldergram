---
title: Deployment
description: Production deployment guide for Foldergram — Docker Compose, bare-metal with systemd, PostgreSQL, reverse proxy, upgrades, and backups.
---

# Deployment

This guide covers running Foldergram in a stable production environment. For first-time setup, see [Installation](./installation.md). For all environment variables, see [Configuration](./configuration.md).

## Choosing a deployment model

| Model | Best for |
| --- | --- |
| Docker Compose (SQLite) | Single-node installs, NAS, home servers, quick setup |
| Docker Compose (PostgreSQL) | Single-node with a managed database sidecar |
| Bare-metal + systemd | Direct Node.js on Linux with full control |
| Bare-metal + PostgreSQL | Large libraries, multi-process setups, operational preference |

All models run the same Node.js app. The difference is in how the process is managed, where the database lives, and whether a reverse proxy sits in front.

---

## Docker Compose (recommended for most users)

### Default setup (SQLite)

The shipped [`docker-compose.yml`](https://github.com/foldergram/foldergram/blob/main/docker-compose.yml) uses the GHCR pre-built image and an SQLite database mounted from `./data/db`.

```bash
mkdir foldergram && cd foldergram
wget -O docker-compose.yml https://raw.githubusercontent.com/foldergram/foldergram/main/docker-compose.yml
mkdir -p data/gallery
docker compose up -d
```

Open `http://localhost:4141`. Migrations run automatically on every startup before the app accepts requests.

### PostgreSQL sidecar

The repo ships [`docker-compose.postgres.yml`](https://github.com/foldergram/foldergram/blob/main/docker-compose.postgres.yml) as a ready-made PostgreSQL Compose file.

```bash
docker compose -f docker-compose.postgres.yml up -d
```

This starts a `postgres:16` container alongside Foldergram and wires the `DATABASE_URL` automatically. Data is persisted in a named Docker volume (`foldergram_pgdata`).

To use it with your own PostgreSQL instance instead, add these variables to the Compose `environment:` block:

```yaml
DB_DRIVER: postgres
DATABASE_URL: postgresql://user:password@your-host:5432/foldergram?sslmode=disable
```

### Keeping the container up to date

```bash
docker compose pull
docker compose up -d
```

Migrations run automatically on the next startup. No manual migration step is needed.

### Persisting data correctly

Ensure your `docker-compose.yml` mounts all four storage paths:

```yaml
volumes:
  - ./data/gallery:/data/gallery      # source media (read-only is fine)
  - ./data/db:/data/db                # SQLite database (read-write)
  - ./data/thumbnails:/data/thumbnails
  - ./data/previews:/data/previews
```

If you switch to PostgreSQL, the `./data/db` volume is no longer used by the app but you can keep the mount to preserve the old SQLite file as a backup.

---

## Bare-metal with systemd

Use this when you want a Node.js process running directly on Linux without Docker.

### 1. Build the app

```bash
git clone https://github.com/foldergram/foldergram.git /opt/foldergram
cd /opt/foldergram
pnpm install
pnpm build
```

`pnpm build` compiles the server (`server/dist/`) and bundles the client (`client/dist/`).

### 2. Create a systemd unit

Create `/etc/systemd/system/foldergram.service`:

```ini
[Unit]
Description=Foldergram Photo Gallery
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/foldergram/server
Environment=NODE_ENV=production
Environment=DATA_ROOT=/opt/foldergram-data
ExecStart=/bin/sh -c 'node dist/scripts/migrate.js && exec node dist/index.js'
Restart=unless-stopped
RestartSec=5

[Install]
WantedBy=multi-user.target
```

If your gallery, thumbnails, or previews directories are in non-default locations, add them as separate `Environment=` lines:

```ini
Environment=GALLERY_ROOT=/mnt/nas/photos
Environment=THUMBNAILS_DIR=/opt/foldergram-data/thumbnails
Environment=PREVIEWS_DIR=/opt/foldergram-data/previews
```

### 3. Enable and start

```bash
systemctl daemon-reload
systemctl enable foldergram
systemctl start foldergram
systemctl status foldergram
```

Logs:

```bash
journalctl -u foldergram -f
```

### 4. With PostgreSQL

Add the database variables to the unit:

```ini
Environment=DB_DRIVER=postgres
Environment=DATABASE_URL=postgresql://foldergram:password@localhost:5432/foldergram?sslmode=disable
After=network.target postgresql.service
```

The `ExecStart` line already runs migrations before starting the server, so no manual migration step is needed after upgrades.

---

## PostgreSQL setup

### Creating the database

```sql
CREATE USER foldergram WITH PASSWORD 'your-password';
CREATE DATABASE foldergram OWNER foldergram;
```

Point `DATABASE_URL` at it and set `DB_DRIVER=postgres`. Foldergram runs all migrations automatically on first startup.

### Connection string format

```
postgresql://user:password@host:5432/dbname?sslmode=disable
```

For TLS connections to a managed database, use `sslmode=require` or `sslmode=verify-full` depending on your provider.

### When to use PostgreSQL over SQLite

- Library over ~50k media items where SQLite write contention becomes noticeable during long scans
- You already operate PostgreSQL and prefer to keep data in your existing database infrastructure
- You want standard PostgreSQL backup tooling (`pg_dump`, streaming replication)

For typical home or small-team use, SQLite is simpler and equally capable.

---

## Reverse proxy

Foldergram does not handle TLS or virtual hosting itself. Put a reverse proxy in front for HTTPS, custom domains, or port 80/443.

### Nginx

```nginx
server {
    listen 80;
    server_name gallery.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name gallery.example.com;

    ssl_certificate     /etc/letsencrypt/live/gallery.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gallery.example.com/privkey.pem;

    client_max_body_size 0;

    location / {
        proxy_pass         http://127.0.0.1:4141;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

### Caddy

```
gallery.example.com {
    reverse_proxy localhost:4141
}
```

Caddy handles TLS automatically via Let's Encrypt.

### CSRF and trusted origins

If the browser-visible origin differs from what the upstream Node process sees (common behind HTTPS terminators), set `CSRF_TRUSTED_ORIGINS` to the public origin:

```env
CSRF_TRUSTED_ORIGINS=https://gallery.example.com
```

---

## Environment for production

Minimum recommended settings for any production deployment:

```env
NODE_ENV=production
DATA_ROOT=/your/data/path
GALLERY_ROOT=/your/gallery/path
IMAGE_DETAIL_SOURCE=preview
DERIVATIVE_MODE=lazy
LOG_VERBOSE=0
```

`DERIVATIVE_MODE=lazy` skips derivative generation during scans and generates thumbnails and previews on first request. This makes the first scan much faster and avoids blocking the scan on large video libraries.

For the first scan of a large library, consider also setting:

```env
SCAN_DISCOVERY_CONCURRENCY=8
SCAN_DERIVATIVE_CONCURRENCY=8
```

Then drop back to the default `4` for steady-state operation.

---

## Upgrades

### Docker

```bash
docker compose pull
docker compose up -d
```

Migrations apply automatically on the next startup.

### Bare-metal

```bash
cd /opt/foldergram
git pull
pnpm install
pnpm build
systemctl restart foldergram
```

The systemd `ExecStart` runs `node dist/scripts/migrate.js` before the server starts, so migrations apply on every restart automatically.

If you deploy client and server separately (e.g. rsync the built assets to a remote host):

```bash
# Build locally
pnpm build

# Push client (no restart needed — static files)
rsync -az --delete client/dist/ user@host:/opt/foldergram/client/dist/

# Push server and restart
rsync -az --delete server/dist/ user@host:/opt/foldergram/server/dist/
ssh user@host "systemctl restart foldergram"
```

---

## Backups

### What to back up

| Path | Contains | Priority |
| --- | --- | --- |
| `GALLERY_ROOT` | Your original source media | Critical |
| `DB_DIR/gallery.sqlite` | All indexed metadata, likes, collections, settings | High |
| `THUMBNAILS_DIR` | Generated thumbnails | Replaceable by rescan |
| `PREVIEWS_DIR` | Generated previews and video transcodes | Replaceable by rescan |

Thumbnails and previews are fully regenerable from originals by running a library scan with thumbnail/preview rebuilds. Back up the originals and the SQLite database; everything else can be reconstructed.

### SQLite backup

```bash
# Safe online copy using SQLite's backup API
sqlite3 /data/db/gallery.sqlite ".backup /backups/gallery-$(date +%Y%m%d).sqlite"
```

Or simply copy the file while the app is stopped:

```bash
systemctl stop foldergram
cp /data/db/gallery.sqlite /backups/gallery-$(date +%Y%m%d).sqlite
systemctl start foldergram
```

### PostgreSQL backup

```bash
pg_dump -U foldergram foldergram | gzip > /backups/foldergram-$(date +%Y%m%d).sql.gz
```

Restore:

```bash
gunzip -c /backups/foldergram-20260101.sql.gz | psql -U foldergram foldergram
```

### Docker volume backup

```bash
docker run --rm \
  -v foldergram_pgdata:/data \
  -v /backups:/backups \
  alpine tar czf /backups/pgdata-$(date +%Y%m%d).tar.gz -C /data .
```
