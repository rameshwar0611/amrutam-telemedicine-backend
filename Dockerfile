FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --ignore-scripts --fetch-retries=0 --fetch-timeout=60000

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --omit=dev --ignore-scripts --fetch-retries=0 --fetch-timeout=60000 && npm cache clean --force && \
    rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
RUN --mount=type=secret,id=npm_ca \
    export http_proxy="${HTTP_PROXY:-}" https_proxy="${HTTPS_PROXY:-}"; \
    ca_bundle=/etc/ssl/certs/ca-certificates.crt; \
    if [ -f /run/secrets/npm_ca ]; then ca_bundle=/run/secrets/npm_ca; fi; \
    apt-get -o Acquire::https::CaInfo="$ca_bundle" update && \
    apt-get -o Acquire::https::CaInfo="$ca_bundle" install --yes --no-install-recommends --only-upgrade perl-base && \
    rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 3000 3001
CMD ["node", "dist/entrypoints/api.js"]
