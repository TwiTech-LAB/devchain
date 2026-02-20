# syntax=docker/dockerfile:1.7

FROM node:20-slim AS builder

WORKDIR /app
ARG PNPM_VERSION=10.21.0

# Build toolchain required by native modules (better-sqlite3, node-pty)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ gcc ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Workspace manifests for dependency resolution/cache
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/local-app/package.json ./apps/local-app/
COPY packages/shared/package.json ./packages/shared/

# Install only the dependency graph required by local-app.
# Ignore scripts here because the root postinstall script is not needed in this image.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter local-app...

# Ensure native modules are built in the Debian/glibc image
RUN pnpm --filter local-app... rebuild better-sqlite3 node-pty

# Source files required to build local-app and workspace dependency
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src

COPY apps/local-app/nest-cli.json ./apps/local-app/
COPY apps/local-app/tsconfig.json ./apps/local-app/
COPY apps/local-app/vite.config.ts ./apps/local-app/
COPY apps/local-app/postcss.config.js ./apps/local-app/
COPY apps/local-app/tailwind.config.js ./apps/local-app/
COPY apps/local-app/index.html ./apps/local-app/
COPY apps/local-app/drizzle.config.ts ./apps/local-app/
COPY apps/local-app/public ./apps/local-app/public
COPY apps/local-app/src ./apps/local-app/src
COPY apps/local-app/templates ./apps/local-app/templates
COPY apps/local-app/drizzle ./apps/local-app/drizzle

RUN pnpm --filter @devchain/shared build
RUN pnpm --filter local-app build

# Prepare production bundle with resolved workspace dependencies
RUN pnpm --filter local-app deploy --prod /app/deploy

FROM node:20-slim AS production

WORKDIR /app/apps/local-app
ARG CLAUDE_CODE_VERSION=2.1.47
ARG CODEX_VERSION=0.104.0
ARG GEMINI_CLI_VERSION=0.29.5

# Runtime system dependencies required by local-app
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       tmux git ca-certificates curl gnupg sudo \
       procps less ripgrep openssh-client \
       jq wget unzip file patch iputils-ping \
       vim-tiny tree iproute2 net-tools lsof \
    && install -m 0755 -d /etc/apt/keyrings \
    && install -m 0755 -d /etc/sudoers.d \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && . /etc/os-release \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node \
    && mkdir -p /home/node/.claude /home/node/.codex /home/node/.gemini /home/node/.devchain \
    && chown -R node:node /home/node \
    && printf '{\n  "hasCompletedOnboarding": true,\n  "autoCompactEnabled": true,\n  "effortCalloutDismissed": true\n}\n' > /home/node/.claude.json \
    && printf '{\n  "skipDangerousModePermissionPrompt": true,\n  "env": {\n    "DISABLE_AUTOUPDATER": "1"\n  }\n}\n' > /home/node/.claude/settings.json \
    && printf 'check_for_update_on_startup = false\n\n[notice.model_migrations]\n"gpt-5.2" = "gpt-5.3-codex"\n' > /home/node/.codex/config.toml \
    && printf '{\n  "security": {\n    "auth": {\n      "selectedType": "oauth-personal"\n    }\n  },\n  "ui": {\n    "theme": "Default"\n  },\n  "general": {\n    "previewFeatures": false,\n    "enableAutoUpdate": false\n  }\n}\n' > /home/node/.gemini/settings.json \
    && printf '{\n  "/project": "TRUST_FOLDER"\n}\n' > /home/node/.gemini/trustedFolders.json \
    && chown node:node /home/node/.claude.json /home/node/.claude/settings.json /home/node/.codex/config.toml /home/node/.gemini/settings.json /home/node/.gemini/trustedFolders.json \
    && printf '[safe]\n\tdirectory = *\n' > /home/node/.gitconfig \
    && chown node:node /home/node/.gitconfig \
    && rm -rf /var/lib/apt/lists/*

# Provider CLIs required by containerized DevChain
ENV PATH=/home/node/.local/bin:${PATH}

RUN su - node -c "curl -fsSL https://claude.ai/install.sh | bash -s -- ${CLAUDE_CODE_VERSION}"

RUN npm install -g @openai/codex@${CODEX_VERSION} @google/gemini-cli@${GEMINI_CLI_VERSION} \
    && claude --version \
    && codex --version \
    && gemini --version \
    && docker --version \
    && docker compose version \
    && npm cache clean --force

COPY --from=builder /app/deploy/package.json ./package.json
COPY --from=builder /app/deploy/node_modules ./node_modules
COPY --from=builder /app/deploy/dist ./dist
COPY --from=builder /app/apps/local-app/drizzle ./drizzle
COPY apps/local-app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh \
    && find ./drizzle -type d -exec chmod 755 {} + \
    && find ./drizzle -type f -exec chmod 644 {} +

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV TEMPLATES_DIR=/app/apps/local-app/dist/templates

EXPOSE 3000

USER node

CMD ["./docker-entrypoint.sh"]
