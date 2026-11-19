# Vendored Coolify API descriptions

Copies of Coolify's `openapi.json`, kept byte for byte as fetched from
`https://raw.githubusercontent.com/coollabsio/coolify/<ref>/openapi.json`. Don't edit them.
`npm run gen:coolify` builds `src/backend/coolify/generated/operations.ts` from them, and
`tests/backend/coverage.test.ts` checks `docs/coverage.md` and the generated table against them.

| File                  | Ref               | Commit                                     | Fetched    |
| --------------------- | ----------------- | ------------------------------------------ | ---------- |
| `openapi-v4.7.5.json` | tag `v4.7.5`      | `378ce3735c4522ebb6b68e93b909b0511f278763` | 2026-11-19 |
| `openapi-main.json`   | branch `main`     | `c3d137e165762e9f582164076c038692b7a31ee0` | 2026-11-19 |
| `openapi-next.json`   | branch `next`     | `ed1e184074f6a59576932c475cc7e7698ae03ca2` | 2026-11-19 |

Each commit was read with `git ls-remote` at fetch time, and each file was fetched again by that commit and
found identical.

## Updating

1. Fetch the new `openapi.json` into a fresh, empty directory, check it is the file you expect, and copy it
   over the old one. Record the ref, commit and date above.
2. Run `npm run gen:coolify`.
3. Run `npx vitest run tests/backend/coverage.test.ts` and add a `docs/coverage.md` row for each new
   operation it reports.
