FROM node:22-alpine AS build
WORKDIR /workspace
RUN npm install -g pnpm@10.33.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/superhive/package.json ./packages/superhive/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/docs/package.json ./apps/docs/package.json
RUN pnpm install --filter @superhive/docs --frozen-lockfile
COPY apps/docs ./apps/docs
ARG DOCS_SITE_URL
ENV DOCS_SITE_URL=$DOCS_SITE_URL
RUN pnpm --filter @superhive/docs build:deploy

FROM nginx:1.28-alpine
COPY apps/docs/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/docs/dist /usr/share/nginx/html
EXPOSE 80
