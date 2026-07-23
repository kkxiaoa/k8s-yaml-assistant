FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS verify
COPY . .
RUN npm test
RUN npm run typecheck

FROM verify AS index
RUN --mount=type=secret,id=voyage_api_key,required=true \
    DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic \
    DEEPSEEK_ANSWER_MODEL=deepseek-v4-flash \
    VOYAGE_EMBEDDING_URL=https://api.voyageai.com/v1/embeddings \
    VOYAGE_RERANK_URL=https://api.voyageai.com/v1/rerank \
    VOYAGE_EMBEDDING_MODEL=voyage-3 \
    VOYAGE_RERANK_MODEL=rerank-2.5 \
    INDEX_DIR=/app/data/index \
    ENABLE_QUERY_EXPANSION=true \
    VOYAGE_API_KEY="$(cat /run/secrets/voyage_api_key)" \
    npm run index:build

FROM verify AS build
RUN --network=none npm run build

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:fccdbb0a547c14e23fcf4ce8ad62ca5d43b4faae8d22cd292f490fef9946c96e AS runtime-base
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=base /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chown=10001:10001 /app/.next/standalone ./
COPY --from=build --chown=10001:10001 /app/.next/static ./.next/static
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/node"]
CMD ["server.js"]

FROM runtime-base AS runtime
COPY --from=index --chown=10001:10001 /app/data/index ./data/index
