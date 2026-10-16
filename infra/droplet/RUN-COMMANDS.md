# paperclip-1 droplet (165.22.133.121) — run commands (reconstructed from `docker inspect`, 2026-10-16)

Secrets are NOT in this repo. Each `*.env.example` lists variable names only; real values live on the droplet in
/opt/openjarvis/jarvis.env, /opt/paperclip/docker/.env, /opt/paperclip/docker/paperclip.env.
POSTGRES_PASSWORD in paperclip docker-compose.yml was redacted to an env reference for this backup.

## OpenJarvis (image `openjarvis:litellm`)
Dockerfile change: added `--extra inference-litellm` to `uv export` (see Dockerfile.litellm.diff).

    cd /opt/openjarvis && docker build -f deploy/docker/Dockerfile -t openjarvis:litellm .
    docker run -d --name openjarvis --restart unless-stopped --network host \
      --env-file /opt/openjarvis/jarvis.env \
      -v openjarvis-home:/home/openjarvis \
      openjarvis:litellm serve --host 0.0.0.0 --port 8000
Config: /var/lib/docker/volumes/openjarvis-home/_data/.openjarvis/config.toml
(--env-file assumed from jarvis.env presence; verify.)

## Paperclip
    cd /opt/paperclip/docker && docker compose -f docker-compose.yml -f docker-compose.override.yml up -d

## plat-admin (nginx:alpine)
    docker run -d --name plat-admin -v /opt/plat-admin/default.conf:/etc/nginx/conf.d/default.conf:ro \
      -v /opt/plat-admin/dist:/usr/share/nginx/html:ro nginx:alpine
(port/network settings not captured — check `docker inspect plat-admin`.)
