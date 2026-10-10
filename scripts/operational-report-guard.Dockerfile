# A deliberately narrow overlay on the verified running main API image.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG SOURCE_REVISION
LABEL cz.csm.sim.operational-report-guard="v1" \
      cz.csm.sim.monitor-source-revision="${SOURCE_REVISION}"
COPY operations-summary.ts /app/apps/simulator-api/src/operations-summary.ts
COPY operations-summary.js /app/apps/simulator-api/dist/operations-summary.js
