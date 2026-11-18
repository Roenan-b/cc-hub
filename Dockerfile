# All-in-one cc-hub image: hub + tmux + Claude Code, running as an unprivileged
# user. The container is also a sandbox boundary for the agents: they can only
# touch /workspace, /vault, and their own home.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git ca-certificates curl ripgrep procps less \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (channels need >= 2.1.80; permission relay is best on >= 2.1.234).
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

RUN useradd -m -s /bin/bash agent && mkdir -p /workspace /vault && chown agent:agent /workspace /vault
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=agent:agent . .

USER agent
ENV TERM=xterm-256color \
    HUB_HOST=0.0.0.0 \
    HUB_PORT=8787 \
    HUB_STATE_DIR=/home/agent/.cc-hub \
    HUB_VAULT=/vault \
    HUB_WORKSPACE_ROOTS=/workspace \
    HUB_TRUST_PROXY=1
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "src/hub.mjs"]
