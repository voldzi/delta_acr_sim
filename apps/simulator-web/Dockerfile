FROM node:24-alpine AS build
ARG VITE_COP_DISPLAY_URL=https://cop.zeleznalady.cz
ARG SIM_WEB_MODE=token
ARG VITE_SIM_OIDC_ISSUER=
ARG VITE_SIM_OIDC_CLIENT_ID=csm-sim-web
ARG VITE_SIM_OIDC_SCOPE="openid profile email"
ARG VITE_SIM_PUBLIC_READ_ENABLED=false
ARG SIM_WEB_ALLOW_MANUAL_LOGIN=false
WORKDIR /app
COPY .corepack-pnpm-10.33.0.tgz /tmp/corepack-pnpm-10.33.0.tgz
RUN corepack enable && corepack install -g /tmp/corepack-pnpm-10.33.0.tgz && rm /tmp/corepack-pnpm-10.33.0.tgz
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY apps/simulator-web ./apps/simulator-web
RUN --mount=type=cache,id=csm-sim-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked pnpm install --frozen-lockfile
RUN VITE_COP_DISPLAY_URL="$VITE_COP_DISPLAY_URL" \
  VITE_SIM_AUTH_MODE="$SIM_WEB_MODE" \
  VITE_SIM_OIDC_ISSUER="$VITE_SIM_OIDC_ISSUER" \
  VITE_SIM_OIDC_CLIENT_ID="$VITE_SIM_OIDC_CLIENT_ID" \
  VITE_SIM_OIDC_SCOPE="$VITE_SIM_OIDC_SCOPE" \
  VITE_SIM_PUBLIC_READ_ENABLED="$VITE_SIM_PUBLIC_READ_ENABLED" \
  VITE_SIM_ALLOW_TOKEN_LOGIN="$SIM_WEB_ALLOW_MANUAL_LOGIN" \
  pnpm --filter @csm-sim/simulator-web build

FROM nginx:1.29-alpine AS runtime
RUN mkdir -p /etc/nginx/includes
COPY apps/simulator-web/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY apps/simulator-web/nginx/internal-provider-access.conf /etc/nginx/includes/internal-provider-access.conf
COPY apps/simulator-web/nginx/provider-cache.conf /etc/nginx/includes/provider-cache.conf
COPY apps/simulator-web/nginx/security-headers.conf /etc/nginx/includes/security-headers.conf
COPY --from=build /app/apps/simulator-web/dist /usr/share/nginx/html
RUN chmod -R a+rX /usr/share/nginx/html
EXPOSE 80
