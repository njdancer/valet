# The blind relay's container. Its build context is a folder holding only this file, fly.toml and
# main.js, the bundle from `node apps/blind-relay/scripts/build.mjs` (.github/workflows/deploy-relay.yml).
FROM node:24-alpine
WORKDIR /app
COPY main.js ./main.js
ENV NODE_ENV=production
USER node
EXPOSE 8443
CMD ["node", "main.js"]
