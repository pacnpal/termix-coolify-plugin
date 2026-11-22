# This repo's registry

This repo is its own Termix plugin registry. Termix can install Coolify for Termix from it and update it
from it, without the community registry.

| What          | Where                                                                                 |
| ------------- | ------------------------------------------------------------------------------------- |
| Registry URL  | `https://raw.githubusercontent.com/pacnpal/termix-coolify-plugin/registry/index.json` |
| Registry id   | `pacnpal-coolify`, named "Coolify for Termix (pacnpal)"                               |
| Public key    | `registry/public-key.txt` on `main`, one line of base64                               |
| Key id        | `d07bfdc9da00b6e7`, also in the README. Termix shows it when you add the registry     |
| Index builder | `scripts/registry-index.mjs` (rules in `scripts/registry-lib.mjs`)                    |
| Workflow      | `.github/workflows/registry.yml`                                                      |

## Add it in Termix

1. Open **Plugins**, then **Registries**, then **Add registry**.
2. Paste the registry URL and choose **Check**.
3. Compare the key id Termix shows with the one in this repo's README. Only go on when they match.
4. Choose **Trust and add**. Coolify for Termix is then offered from it, and a copy installed from it
   updates only from it. Termix reads the index again every 15 minutes.

## How the index is built

The Registry workflow runs when a release is published, edited or deleted by hand, every hour, and when you
run it by hand. It checks out `main`, then:

1. Refuses to go on without a valid `registry/public-key.txt`. If the file is ever missing, the hourly run
   stops with a notice instead.
2. Reads every release of this repo. A release counts when it is published (not a draft) and has
   `coolify-<version>.tmxplug`, `coolify-<version>.tmxplug.sig` and `coolify-<version>.tmxplug.sigstore.json`.
   Others are skipped and named in the log.
3. Downloads each counted release and checks it: the `.sig` must verify against the public key, exactly as
   `npx termix-plugin verify` checks it; the manifest inside must have the tag's version, the file's name and
   this repository; and the provenance bundle must parse as a Sigstore bundle whose in-toto subject names the
   file and its sha256 (a structural check: Termix verifies the bundle's signature at download). If any check
   fails, nothing is published: the workflow fails and the old index stays.
4. Writes `index.json`, the same way Termix-Registry's sync job (`scripts/sync.mjs` and `scripts/lib.mjs`)
   writes the official one: sha256, size, signature, capabilities, engine ranges, the version's
   `CHANGELOG.md` section as notes, the provenance link, and the listing (name, description, features, docs,
   what the plugin contributes) from the newest stable manifest.
   - Stable versions go in `versions`, betas newer than the newest stable in `prereleases`, and betas older
     than it are left out.
   - A release whose `engine.termix` Termix 26.10.2 can't satisfy goes in `gated` instead, which Termix up to
     26.10.2 never reads. This plugin needs `>=26.11.2-0`, so its releases are in `gated`.
5. Checks the index against the registry index schema (vendored in `vendor/termix-registry/`) and pushes it
   to the `registry` branch with `inputs.json`, the record the hourly shortcut compares. The first run
   creates the branch. With no signed release yet, the index is valid and its `plugins` list is empty.

The Release workflow publishes with the workflow's own token, and GitHub starts no workflow for what that
token does, so a release made by Release reaches the index on the next hourly run. Run **Registry** by hand
to publish it at once.

Every download counts toward a release's download total, so the hourly run downloads nothing when every
input the checks read is byte for byte what the last full run read: the sha256 of each counted release's
`.tmxplug`, `.sig` and `.sigstore.json` (from the GitHub API's asset digests), the public key,
`first-version.txt`, a hash of the scripts, schema and package versions that do the checks, and the
published `index.json` itself. Any difference, or an asset with no digest, means a full download and check.
A release published, edited or deleted by hand, and a run by hand, always download and check everything
again.

## Release a version

1. **The signing key secret.** Done once: the private key is the repository secret
   `TERMIX_PLUGIN_SIGNING_KEY`, and its public key is `registry/public-key.txt` (key id `d07bfdc9da00b6e7`).
   Never commit the private key.
2. **Create `dev-X.Y.Z` from `main`**, with `X.Y.Z` the version to release and its notes under `## X.Y.Z`
   at the top of `CHANGELOG.md`. Release stamps the version into `manifest.json` and `package.json`.
3. **Run Release** (Actions, Release, Run workflow) on `dev-X.Y.Z`, with channel **stable** or **beta**. It
   tests, builds, packs, signs with `TERMIX_PLUGIN_SIGNING_KEY` and publishes the `.tmxplug`, `.tmxplug.sig`
   and `.tmxplug.sigstore.json`. A release without the secret has no `.sig` and is never listed here.
4. **The Registry workflow updates the index**: on its next hourly run, or at once when you run it by hand.
   Check the run's log for the versions it listed.

## Rotate the key

Termix pins a registry's key when it is added and never accepts a new one on its own, so a rotation means
every Termix that added this registry has to add it again.

1. On a computer you trust, outside this repo, run `npx termix-plugin keygen --out <dir>`. It writes the
   private key to `<dir>/termix-plugin-signing.key` and prints the public key and key id.
2. Replace the `TERMIX_PLUGIN_SIGNING_KEY` secret with the new private key and delete the file.
3. Replace `registry/public-key.txt` with the new public key, and the key id here, in the README and in
   `tests/backend/registry/index.test.ts`, which checks the committed key against it.
4. Add `registry/first-version.txt` holding the first version the new key will sign (one line, like
   `1.3.0`). Releases are immutable, so older ones keep the old key's `.sig`; the index leaves out every
   release older than this version instead of failing on them.
5. Release that version as above. Until it is out, the index lists no versions.

If the old key leaked, rotate at once and tell users, since anyone with it could sign a file this registry's
old key accepts.

## When the key changes

When the key in `index.json` changes, Termix stops installing and updating from this registry. To get
updates again, a Termix admin:

1. Uninstalls Coolify for Termix if it was installed from this registry. Termix asks for this before the
   registry can be removed.
2. Removes the registry in **Plugins**, **Registries**.
3. Adds it again with the same URL, checks the new key id against the README, and chooses **Trust and add**.
4. Installs Coolify for Termix from it again.
