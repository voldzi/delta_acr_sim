# Offline fixture only. The main runner must first verify that BOTH exact images
# already exist locally. Never add a tag fallback, pull, apk, npm or download.
# Build context:
#   Dockerfile, harness.mjs
#   sql/{schema.sql,002_account_erasure.sql,003_guarded_operations.sql,
#        004_read_admission_facts.sql}
#   root-tree/{package.json,root-records.mjs,root-read-admission.mjs,
#              read-admission-facts.mjs,node_modules/<dereferenced pg closure>}
# Classic offline build may be needed for local image-ID FROM references.
# The same files also work with the runner's create+docker-cp fallback.
FROM sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS node_local
FROM sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
USER 0:0
COPY --from=node_local /usr/local/bin/node /usr/local/bin/node
COPY --from=node_local /usr/lib/libstdc++.so.6* /usr/lib/
COPY --from=node_local /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY root-tree/ /opt/cop-account-safety/
COPY sql/ /fixture/sql/
COPY harness.mjs /fixture/harness.mjs
# Custody is checked again by the ACTUAL COP helper and by the harness. App
# package-manager symlinks must already have been dereferenced by packaging.
RUN chown -R 0:0 /opt/cop-account-safety /fixture \
 && find /opt/cop-account-safety /fixture -type d -exec chmod 0555 '{}' ';' \
 && find /opt/cop-account-safety /fixture -type f -exec chmod 0444 '{}' ';'
WORKDIR /fixture
ENTRYPOINT ["/usr/local/bin/node", "/fixture/harness.mjs", "--run"]
