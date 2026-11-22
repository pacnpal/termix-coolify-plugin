# Vendored Termix registry index schema

`registry-index-schema.json` is a copy of the schema Termix-Registry keeps for a registry's `index.json`,
byte for byte as fetched. Don't edit it. `tests/backend/registry/index.test.ts` and
`scripts/registry-index.mjs` check every index this repo publishes against it (see `docs/registry.md`).

| File                         | Source                                                                                              | Commit                                     | Fetched    |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------- |
| `registry-index-schema.json` | https://raw.githubusercontent.com/Termix-SSH/Termix-Registry/main/registry-index-schema.json | `1cec78823384036f6607a7b94eeb4a9465c2aa3b` | 2026-11-22 |

## Updating

Fetch the file into a fresh, empty directory, check it is the file you expect, copy it over the old one and
record the commit and date above. Then run `npx vitest run tests/backend/registry`.
