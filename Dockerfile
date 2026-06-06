FROM node:24-slim
WORKDIR /app

# Install production deps only (node:sqlite is built into Node 24, no native build)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the prebuilt compiled output
COPY dist ./dist

# Server-only daemon: HTTP dashboard + pollers, no MCP stdio transport.
# HOME is set so os.homedir() resolves the DB + profile config_dir paths
# against the hostPath mounts the deployment provides at runtime.
# The image itself contains no usage.db or credentials.
ENV CLAUDE_PULSE_SERVER_ONLY=1 \
    HOME=/home/ryan \
    CLAUDE_PULSE_PORT=7778

EXPOSE 7778

CMD ["node", "dist/index.js"]
