# HYPERCADE — one Node process serves API + static dist (TECH-BRIEF §10).
# WASM engines are built in CI (or locally) before docker build; the emsdk
# toolchain stays out of the runtime image.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY shared ./shared
COPY client ./client
RUN test -f client/sdk/gen/box2d.mjs || (echo "run 'npm run wasm' before docker build" && exit 1)
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY shared ./shared
COPY server ./server
COPY --from=build /app/dist ./dist
VOLUME /app/server/data
EXPOSE 8787
CMD ["npx", "tsx", "server/index.ts"]
