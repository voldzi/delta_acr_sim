# UNBUILT: Root must bind sim_reviewed_base to the exact reviewed local OCI layout.
# No syntax/frontend image fetch, RUN, dependencies or implicit registry base.
FROM sim_reviewed_base
COPY apps/simulator-api/dist/user-data.js /app/apps/simulator-api/dist/user-data.js
COPY packages/sim-user-data/bootstrap.mjs /app/packages/sim-user-data/bootstrap.mjs
COPY packages/sim-user-data/pg-errors.mjs /app/packages/sim-user-data/pg-errors.mjs
