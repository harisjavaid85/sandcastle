FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Enable corepack so pnpm resolves to the version pinned in the project's
# packageManager field. Per-user pnpm config (store-dir) is set after the
# USER switch below.
RUN corepack enable

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Shared pnpm store across worktrees — set via .npmrc so it's effective
# without needing to invoke pnpm at build time (corepack shim resolves
# at run time).
RUN mkdir -p /home/agent/.pnpm-store \
  && printf 'store-dir=/home/agent/.pnpm-store\n' > /home/agent/.npmrc

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

# Bake the agent skills at a pinned commit SHA so the in-container agent
# can invoke those skills without paying the per-iteration install cost.
# To bump skills: change SKILLS_SHA and rebuild the image.
ARG SKILLS_REPO=harisjavaid85/ai-agent-skills
ARG SKILLS_SHA=11f5aee
RUN npx --yes skills@latest add ${SKILLS_REPO}@${SKILLS_SHA} --all -g -y

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
