/**
 * Writes this repo's Termix registry index.json from its GitHub releases.
 * The registry workflow (.github/workflows/registry.yml) runs it and pushes
 * the result to the registry branch. See docs/registry.md.
 *
 *   node scripts/registry-index.mjs --repo owner/name --out index.json \
 *     [--key registry/public-key.txt] [--previous old-index.json] [--if-changed]
 *
 * It refuses to run without a valid registry/public-key.txt, and writes
 * nothing unless every release checks out and the index matches the
 * vendored schema. Set GH_TOKEN for the higher GitHub API rate limit.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildIndex,
  downloadReleases,
  keepTimestamp,
  listReleases,
  parseFirstVersion,
  parsePublicKey,
  schemaProblems,
  unchangedSince,
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
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD)
    throw new Error(`${url} is larger than ${MAX_DOWNLOAD} bytes`);
  return buffer;
}

function readPrevious(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
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

  const previous = readPrevious(option(args, "--previous", null));
  const releases = await listReleases(fetchJson, repo);

  // Every download counts in GitHub's download totals, so a scheduled check
  // reads only asset digests and stops when the published index still holds.
  if (
    args.includes("--if-changed") &&
    unchangedSince(previous, releases, publicKey, { since })
  ) {
    write(out, previous);
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
    repository: `https://github.com/${repo}`,
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
