FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY web/package.json web/
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
COPY web/ web/
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY web/package.json web/
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY --from=deps /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY --from=build /app/web/dist web/dist/
COPY migrations/ migrations/
COPY package.json ./
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
