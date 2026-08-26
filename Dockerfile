# Node 20 LTS on Alpine. The app needs no native build toolchain, so a single
# stage is enough - a multi-stage build here would add complexity without
# meaningfully shrinking the image.
FROM node:20-alpine

# tini reaps zombies and forwards signals properly. Without an init, SIGTERM
# goes to PID 1 and the graceful-shutdown handler never runs, so in-flight SSE
# connections and the push queue are dropped on every redeploy.
RUN apk add --no-cache tini

WORKDIR /app

# Copy manifests first so the dependency layer caches independently of source
# changes - a code edit shouldn't trigger a reinstall.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# Persisted state lives here. MOUNT A VOLUME AT THIS PATH IN PRODUCTION - on
# an ephemeral filesystem, every redeploy wipes open swing positions and the
# entire signal journal.
RUN mkdir -p /app/data && chown -R node:node /app

# Drop root. The process only needs to read its own source and write /app/data.
USER node

ENV NODE_ENV=production \
    PORT=4000 \
    SWING_DATA_DIR=/app/data

EXPOSE 4000

# Uses the app's own aggregate health endpoint, which returns 503 when a
# dependency is degraded rather than merely when the process is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/api/public/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
