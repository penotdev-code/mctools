FROM node:24-alpine

WORKDIR /app
COPY config.json ./
COPY server ./server
COPY public ./public
COPY tools ./tools
RUN mkdir -p /data && chown node:node /data

USER node
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "server/server.js"]
