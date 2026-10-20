ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=${SOURCE_REVISION}
COPY app.js routing-service.js routing-work.js mobile-coverage-source.js rebuild-mobile-coverage.js /app/apps/situation-data-api/dist/
