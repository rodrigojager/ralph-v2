FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY src ./src
COPY public ./public
ENV HOST=0.0.0.0 PORT=3000 DATA_FILE=/data/notes.json
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.mjs"]
