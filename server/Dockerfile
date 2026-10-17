FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY package.json server.mjs ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
# Mount persistent storage at /data (docker run -v ..., or a Railway volume; Railway rejects VOLUME lines).
# On Railway the volume is root-owned, so the service sets RAILWAY_RUN_UID=0.
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server.mjs"]
