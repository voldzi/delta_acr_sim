ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=${SOURCE_REVISION}
COPY idsjmk-feed.js sources.js aggregation.js config.js transit-detail.js /app/apps/situation-data-api/dist/
