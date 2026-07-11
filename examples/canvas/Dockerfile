# One image backs every node server AND the vite frontend — built once, services
# differ only by their compose `command`. Build context is the repo root (see
# docker-compose.yml) so the whole pnpm workspace resolves. No build step: the
# example runs straight off TypeScript source via tsx (server) and vite (client).
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
# minimumReleaseAge=0: skip pnpm's default 24h supply-chain age gate for this
# hermetic build. The lockfile is already committed + reviewed, and --frozen-lockfile
# verification (unlike a plain install) ignores minimumReleaseAgeExclude, so a
# freshly-published pinned dep (e.g. a bumped @super-line/*) would otherwise abort
# the image build. Dev/CI installs keep the gate (this override is Docker-only).
RUN pnpm install --frozen-lockfile --config.minimumReleaseAge=0
# Overridden per service in compose (canvas-server vs vite). Default keeps the image runnable alone.
CMD ["pnpm", "--filter", "@super-harness/canvas-server", "exec", "tsx", "server.ts"]
