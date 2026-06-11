# Archived OpenAPI YAML Snapshots

These files are historical service-local OpenAPI YAML snapshots from before the
JSON-first migration.

The binding API contract is now:

```text
openapi/openapi.json
```

Use `scripts/build-openapi-json.rb` to rebuild the composite JSON from these
snapshots while the repository migrates toward direct JSON maintenance or
code-generated JSON.
