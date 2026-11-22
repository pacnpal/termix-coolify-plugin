/**
 * Writes this repo's Termix registry index.json from its GitHub releases.
 * The registry workflow (.github/workflows/registry.yml) runs it and pushes
 * the result to the registry branch. See docs/registry.md.
 *
 *   node scripts/registry-index.mjs --repo owner/name --out index.json \
 *     [--key registry/public-key.txt] [--previous old-index.json] [--if-changed]
 *
 * It also writes inputs.json next to --out, and reads the one next to
 * --previous: the record --if-changed compares (see registry-lib.mjs).
 *
 * It refuses to run without a valid registry/public-key.txt, and writes
 * nothing unless every release checks out and the index matches the
 * vendored schema. Set GH_TOKEN for the higher GitHub API rate limit.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildIndex,
  downloadReleases,
  inputsRecord,
  keepTimestamp,
  listReleases,
  readLimited,
  parseFirstVersion,
  parsePublicKey,
  schemaProblems,
  unchangedSince,
  usablePrevious,
} from "./registry-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_DOWNLOAD = 64 * 1024 * 1024;

function option(args, name, fallback) {
  const at = args.indexOf(name);
  if (at === -1) return fallback;
  const value = args[at + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} needs a value`);
  return value;
}

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

async function fetchJson(apiPath) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GET ${apiPath}: ${response.status}`);
  return response.json();
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
  return readLimited(response, MAX_DOWNLOAD, url);
}

function readPrevious(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * A hash of what does the checks and writes the index: these scripts, the
 * vendored schema and the versions of the packages they import. Part of the
 * inputs record, so changed rules make the next run read everything again.
 */
function toolingHash() {
  const hash = crypto.createHash("sha256");
  for (const file of [
    "scripts/registry-lib.mjs",
    "scripts/registry-index.mjs",
    "vendor/termix-registry/registry-index-schema.json",
  ]) {
    hash.update(`${file}\0`).update(fs.readFileSync(path.join(ROOT, file)));
  }
  for (const pkg of ["@termix-ssh/plugin-sdk", "semver", "ajv"]) {
    const manifest = path.join(ROOT, "node_modules", pkg, "package.json");
    hash.update(
      `\0${pkg}@${JSON.parse(fs.readFileSync(manifest, "utf8")).version}`,
    );
  }
  return hash.digest("hex");
}

/** inputs.json, next to an index.json. */
function inputsPath(indexFile) {
  return path.join(path.dirname(indexFile), "inputs.json");
}

/** Writes the whole file or nothing. */
function write(out, index) {
  const temp = `${out}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(index, null, 2)}\n`);
  fs.renameSync(temp, out);
}

async function main(args) {
  const repo = option(args, "--repo", process.env.GITHUB_REPOSITORY);
  if (!repo || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error("Pass --repo owner/name (or set GITHUB_REPOSITORY)");
  }
  const out = option(args, "--out", null);
  if (!out) throw new Error("Pass --out <file>");
  const keyFile = option(
    args,
    "--key",
    path.join(ROOT, "registry", "public-key.txt"),
  );

  // The key first: nothing is fetched or written without it.
  if (!fs.existsSync(keyFile)) {
    throw new Error(
      `${keyFile} is missing. Add the registry's public key (one line of base64) before publishing; see docs/registry.md`,
    );
  }
  const { publicKey, keyId } = parsePublicKey(fs.readFileSync(keyFile, "utf8"));
  console.log(`Registry key id ${keyId}`);
  // After a key rotation, releases the earlier key signed are left out.
  const firstVersionFile = path.join(
    path.dirname(keyFile),
    "first-version.txt",
  );
  const since = parseFirstVersion(
    fs.existsSync(firstVersionFile)
      ? fs.readFileSync(firstVersionFile, "utf8")
      : undefined,
  );
  if (since) console.log(`Releases from ${since} on`);

  const previousFile = option(args, "--previous", null);
  // An index that isn't valid for this registry is never reused or kept from.
  const previous = usablePrevious(readPrevious(previousFile));
  const repository = `https://github.com/${repo}`;
  const previousInputs = previousFile
    ? readPrevious(inputsPath(previousFile))
    : null;
  const tooling = toolingHash();
  const releases = await listReleases(fetchJson, repo);

  // Every download counts in GitHub's download totals, so a scheduled check
  // reads only asset digests and stops when every input verification reads
  // is the same as in the last full run (registry-lib.mjs lists them).
  if (
    args.includes("--if-changed") &&
    unchangedSince(previousInputs, {
      releases,
      repository,
      publicKey,
      since,
      tooling,
      index: previous,
    })
  ) {
    write(out, previous);
    write(inputsPath(out), previousInputs);
    console.log(`${out}: unchanged, nothing downloaded`);
    return;
  }

  const { ready, skipped } = await downloadReleases(releases, download, {
    since,
  });
  for (const { tag, reason } of skipped)
    console.log(`${tag}: skipped, ${reason}`);

  const built = buildIndex({
    releases: ready,
    publicKey,
    repository,
    updatedAt: new Date().toISOString(),
  });
  const problems = schemaProblems(built);
  if (problems.length > 0) {
    throw new Error(
      `The index does not match the registry index schema:\n  ${problems.join("\n  ")}`,
    );
  }
  const index = keepTimestamp(built, previous);
  write(out, index);
  write(
    inputsPath(out),
    inputsRecord({ ready, repository, publicKey, since, tooling, index }),
  );
  const listed = index.plugins.flatMap((plugin) => [
    ...plugin.versions,
    ...(plugin.prereleases ?? []),
    ...(plugin.gated ?? []),
  ]);
  console.log(
    `${out}: ${listed.length} release(s): ${listed.map((entry) => entry.version).join(", ") || "none"}`,
  );
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`registry index: ${error.message}`);
  process.exit(1);
}
