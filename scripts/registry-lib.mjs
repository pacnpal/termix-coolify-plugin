/**
 * The pure parts of this repo's own Termix registry (docs/registry.md):
 * reading signed GitHub releases and turning them into an index.json that
 * matches vendor/termix-registry/registry-index-schema.json.
 *
 * The rules follow Termix-Registry's scripts/sync.mjs and scripts/lib.mjs
 * (the official registry's sync job), for a registry with one plugin and a
 * pre-chain key: one `signature` per version, no certs.
 *
 * - A release counts once it is published (not a draft) and has
 *   <id>-<version>.tmxplug, its .sig and its .sigstore.json.
 * - Every counted release must check out: the .sig verifies against the
 *   registry's public key exactly as `termix-plugin verify` checks it, the
 *   packed manifest matches the tag, the file name and this repository, and
 *   the provenance bundle names the file and its sha256. Any failure throws,
 *   so an index is never written with a release left out or unverified.
 * - Betas are listed only while newer than the newest stable. A release whose
 *   engine.termix Termix 26.10.2 (the last build that doesn't check it) can't
 *   satisfy goes in gated, which those builds never read.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import zlib from "node:zlib";
import { changelogSection } from "@termix-ssh/plugin-sdk/changelog";
import Ajv2020 from "ajv/dist/2020.js";
import semver from "semver";

export const REGISTRY_ID = "pacnpal-coolify";
export const REGISTRY_NAME = "Coolify for Termix (pacnpal)";
export const LAST_UNCHECKED_CORE = "26.10.2";

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;
const MAX_UNPACKED = 256 * 1024 * 1024;

/** First 16 hex characters of the sha256 of the raw public key: the key id Termix shows. */
export function keyIdOf(publicKey) {
  return crypto
    .createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Reads registry/public-key.txt: one line holding a base64 raw Ed25519 public
 * key, as `termix-plugin keygen` prints it. Throws for anything else, a
 * private key included, without echoing what it was given.
 */
export function parsePublicKey(text) {
  const lines = String(text ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => line.trim() !== "");
  if (lines.length !== 1) {
    throw new Error("The registry public key must be one line of base64");
  }
  const publicKey = lines[0].trim();
  if (!PUBLIC_KEY.test(publicKey)) {
    throw new Error(
      "The registry public key is not a base64 Ed25519 public key (44 characters)",
    );
  }
  const raw = Buffer.from(publicKey, "base64");
  if (raw.length !== 32 || raw.toString("base64") !== publicKey) {
    throw new Error("The registry public key is not 32 bytes of base64");
  }
  try {
    crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new Error(
      "The registry public key is not a valid Ed25519 public key",
    );
  }
  return { publicKey, keyId: keyIdOf(publicKey) };
}

/**
 * True when the .sig text is a base64 Ed25519 signature over the raw sha256
 * of the file by the key: the check `termix-plugin verify` makes.
 */
export function verifySignature(buffer, sigText, publicKey) {
  const signature = Buffer.from(String(sigText ?? "").trim(), "base64");
  if (signature.length !== 64) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey, "base64")]),
      format: "der",
      type: "spki",
    });
    const digest = crypto.createHash("sha256").update(buffer).digest();
    return crypto.verify(null, digest, key, signature);
  } catch {
    return false;
  }
}

/** Orders strings by UTF-16 code unit, the same on every machine and locale. */
export function byCodeUnit(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** A NUL-padded tar header field: everything before its first NUL. One linear scan. */
export function cutAtNul(value) {
  const end = value.indexOf("\0");
  return end === -1 ? value : value.slice(0, end);
}

/** Reads one file out of a .tmxplug (a gzipped ustar archive), or null. */
export function readTmxplugFile(buffer, wanted) {
  const tar = zlib.gunzipSync(buffer, { maxOutputLength: MAX_UNPACKED });
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      cutAtNul(header.subarray(start, start + length).toString("utf8"));
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const start = offset + 512;
    if (name === wanted) return tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

export function isPrerelease(version) {
  return semver.prerelease(version) !== null;
}

/** Semver precedence, newest last: 1.1.0-beta.2 < 1.1.0-beta.10 < 1.1.0. */
export function compareVersions(a, b) {
  return semver.compare(a, b);
}

/** True when the last Termix that doesn't check engine.termix can't run this release. */
export function needsNewerCore(entry) {
  const range = entry.engine?.termix;
  if (!range || semver.validRange(range) === null) return false;
  return !semver.satisfies(LAST_UNCHECKED_CORE, range);
}

/**
 * Sorts a plugin's releases into versions, prereleases and gated, newest
 * first. Betas are kept only while newer than the newest stable.
 */
export function placeReleases(plugin) {
  const releases = [
    ...(plugin.versions ?? []),
    ...(plugin.prereleases ?? []),
    ...(plugin.gated ?? []),
  ].sort((a, b) => compareVersions(b.version, a.version));
  const newestStable = releases.find((r) => !isPrerelease(r.version));
  const kept = releases.filter(
    (r) =>
      !isPrerelease(r.version) ||
      !newestStable ||
      compareVersions(r.version, newestStable.version) > 0,
  );
  const open = kept.filter((r) => !needsNewerCore(r));
  const gated = kept.filter((r) => needsNewerCore(r));
  const prereleases = open.filter((r) => isPrerelease(r.version));
  const rest = { ...plugin };
  delete rest.versions;
  delete rest.prereleases;
  delete rest.gated;
  return {
    ...rest,
    versions: open.filter((r) => !isPrerelease(r.version)),
    ...(prereleases.length > 0 ? { prereleases } : {}),
    ...(gated.length > 0 ? { gated } : {}),
  };
}

/**
 * registry/first-version.txt: the first version the current key signed, set
 * when the key is rotated (docs/registry.md). Null when the file is absent.
 */
export function parseFirstVersion(text) {
  if (text === undefined || text === null) return null;
  const lines = String(text)
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => line.trim() !== "");
  const version = lines.length === 1 ? lines[0].trim() : "";
  if (semver.valid(version) !== version || version === "") {
    throw new Error(
      "registry/first-version.txt must hold one version, like 1.2.0",
    );
  }
  return version;
}

/**
 * The .tmxplug, .sig and provenance assets of a published release, or why it
 * doesn't count. With since, a release older than that version was signed by
 * an earlier key and doesn't count either.
 */
export function releaseAssets(release, { since = null } = {}) {
  if (release.draft) return { skip: "a draft" };
  const tagged = String(release.tag_name ?? "").replace(/^v/, "");
  if (since && semver.valid(tagged) && semver.lt(tagged, since)) {
    return {
      skip: `older than ${since}, the first version the current key signed`,
    };
  }
  const artifact = release.assets?.find((asset) =>
    asset.name.endsWith(".tmxplug"),
  );
  if (!artifact) return { skip: "no .tmxplug" };
  const sig = release.assets.find(
    (asset) => asset.name === `${artifact.name}.sig`,
  );
  if (!sig) return { skip: `no ${artifact.name}.sig` };
  const provenance = release.assets.find(
    (asset) => asset.name === `${artifact.name}.sigstore.json`,
  );
  if (!provenance) return { skip: `no ${artifact.name}.sigstore.json` };
  return { assets: { artifact, sig, provenance } };
}

/**
 * Downloads the three files of every release that counts. download(url)
 * resolves to a Buffer. Returns the downloaded releases and the skipped tags.
 */
export async function downloadReleases(releases, download, options = {}) {
  const ready = [];
  const skipped = [];
  for (const release of releases) {
    const { assets, skip } = releaseAssets(release, options);
    if (!assets) {
      skipped.push({ tag: release.tag_name, reason: skip });
      continue;
    }
    const artifact = await download(assets.artifact.browser_download_url);
    const sigBytes = await download(assets.sig.browser_download_url);
    const provenanceBytes = await download(
      assets.provenance.browser_download_url,
    );
    ready.push({
      release,
      assets,
      files: {
        artifact,
        sig: sigBytes.toString("utf8"),
        provenance: provenanceBytes.toString("utf8"),
      },
      // The bytes verification read, for the inputs record.
      digests: {
        tmxplug: sha256Hex(artifact),
        sig: sha256Hex(sigBytes),
        provenance: sha256Hex(provenanceBytes),
      },
    });
  }
  return { ready, skipped };
}

/** Every release of a repo, read page by page. fetchJson(path) takes an api.github.com path. */
export async function listReleases(fetchJson, repo) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await fetchJson(
      `/repos/${repo}/releases?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch))
      throw new Error(`${repo}: the releases answer is not a list`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

/** Whether a Sigstore bundle's in-toto statement names this file and digest. */
export function bundleDescribes(bundleText, fileName, sha256Hex) {
  try {
    const envelope = JSON.parse(bundleText)?.dsseEnvelope;
    if (envelope?.payloadType !== "application/vnd.in-toto+json") return false;
    const statement = JSON.parse(
      Buffer.from(envelope.payload, "base64").toString("utf8"),
    );
    return (statement.subject ?? []).some(
      (subject) =>
        subject?.digest?.sha256?.toLowerCase() === sha256Hex &&
        String(subject.name ?? "")
          .split("/")
          .pop() === fileName,
    );
  } catch {
    return false;
  }
}

/** The manifest's engine ranges. */
function engineOf(manifest) {
  const { api, termix } = manifest.engine ?? {};
  if (typeof api !== "string" || typeof termix !== "string") return null;
  return { api, termix };
}

/** What kinds of things the plugin adds, so Termix can filter by them. */
function contributesOf(manifest) {
  const kinds = Object.keys(manifest.contributes ?? {}).filter((kind) =>
    /^[A-Za-z]+$/.test(kind),
  );
  return kinds.length > 0 ? { contributes: kinds.sort(byCodeUnit) } : {};
}

/** The manifest's docs link, when it is https. */
function docsOf(manifest) {
  if (typeof manifest.docs !== "string") return {};
  try {
    const url = new URL(manifest.docs);
    return url.protocol === "https:"
      ? { docs: url.toString().replace(/\/$/, "") }
      : {};
  } catch {
    return {};
  }
}

/** The listing fields of the plugin, from the newest stable manifest. */
function listing(manifest, repository) {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    author: manifest.author?.name ?? String(manifest.author ?? ""),
    category: manifest.category,
    repository,
    icon: manifest.icon ?? "Puzzle",
    ...(typeof manifest.video === "string" ? { video: manifest.video } : {}),
    ...(Array.isArray(manifest.features) && manifest.features.length > 0
      ? { features: manifest.features }
      : {}),
    ...docsOf(manifest),
    ...contributesOf(manifest),
  };
}

/** Checks one downloaded release and returns its manifest and index entry. Throws on any problem. */
function readRelease({ release, assets, files }, publicKey, repository) {
  const where = release.tag_name;
  const { artifact } = files;
  if (!verifySignature(artifact, files.sig, publicKey)) {
    throw new Error(
      `${where}: the signature in ${assets.sig.name} does not match registry/public-key.txt`,
    );
  }
  const raw = readTmxplugFile(artifact, "manifest.json");
  if (!raw)
    throw new Error(`${where}: no manifest.json in ${assets.artifact.name}`);
  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(
      `${where}: manifest.json in ${assets.artifact.name} is not valid JSON`,
    );
  }
  if (
    typeof manifest.version !== "string" ||
    semver.valid(manifest.version) !== manifest.version
  ) {
    throw new Error(`${where}: the manifest version is not a semver version`);
  }
  if (`v${manifest.version}` !== release.tag_name) {
    throw new Error(`${where}: the manifest version is ${manifest.version}`);
  }
  if (assets.artifact.name !== `${manifest.id}-${manifest.version}.tmxplug`) {
    throw new Error(
      `${where}: the file name ${assets.artifact.name} is not ${manifest.id}-${manifest.version}.tmxplug`,
    );
  }
  if (manifest.repository !== repository) {
    throw new Error(`${where}: the manifest repository is not ${repository}`);
  }
  const engine = engineOf(manifest);
  if (!engine)
    throw new Error(
      `${where}: the manifest has no engine.api and engine.termix ranges`,
    );
  const sha256 = crypto.createHash("sha256").update(artifact).digest("hex");
  if (!bundleDescribes(files.provenance, assets.artifact.name, sha256)) {
    throw new Error(
      `${where}: the provenance bundle ${assets.provenance.name} is not for this file`,
    );
  }
  const changelog = readTmxplugFile(artifact, "CHANGELOG.md");
  const notes = changelog
    ? changelogSection(changelog.toString("utf8"), manifest.version)
    : null;
  const entry = {
    version: manifest.version,
    api: engine.api.match(/\d+/)?.[0] ?? "",
    url: assets.artifact.browser_download_url,
    sha256,
    signature: String(files.sig).trim(),
    size: artifact.length,
    capabilities: manifest.capabilities ?? [],
    engine,
    ...(manifest.dependencies && Object.keys(manifest.dependencies).length > 0
      ? { dependencies: manifest.dependencies }
      : {}),
    releaseNotesUrl: release.html_url,
    ...(notes ? { notes: notes.slice(0, 20_000) } : {}),
    provenance: { url: assets.provenance.browser_download_url },
    // The asset upload time, which is the release date.
    publishedAt: new Date(
      assets.artifact.updated_at ?? release.published_at,
    ).toISOString(),
  };
  return { manifest, entry };
}

/**
 * The whole index.json from downloaded releases (downloadReleases' ready
 * list). Throws when the key or any release doesn't check out.
 */
export function buildIndex({ releases, publicKey, repository, updatedAt }) {
  const key = parsePublicKey(publicKey).publicKey;
  const found = releases.map((one) => readRelease(one, key, repository));
  const index = {
    registry: REGISTRY_ID,
    name: REGISTRY_NAME,
    apiVersion: 1,
    publicKey: key,
    updatedAt,
    plugins: [],
  };
  if (found.length === 0) return index;

  const ids = new Set(found.map(({ manifest }) => manifest.id));
  if (ids.size > 1) {
    throw new Error(
      `The releases use more than one plugin id: ${[...ids].sort(byCodeUnit).join(", ")}`,
    );
  }
  const seen = new Set();
  for (const { manifest } of found) {
    if (seen.has(manifest.version))
      throw new Error(`${manifest.version} is released twice`);
    seen.add(manifest.version);
  }

  found.sort((a, b) => compareVersions(b.manifest.version, a.manifest.version));
  // Listing text follows stable, so a beta can't change what stable users see.
  const latest = (
    found.find(({ manifest }) => !isPrerelease(manifest.version)) ?? found[0]
  ).manifest;
  index.plugins.push(
    placeReleases({
      ...listing(latest, repository),
      versions: found.map(({ entry }) => entry),
    }),
  );
  return index;
}

let validator = null;

function schemaValidator() {
  if (validator) return validator;
  const schema = JSON.parse(
    fs.readFileSync(
      new URL(
        "../vendor/termix-registry/registry-index-schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("uri", (value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  });
  ajv.addFormat(
    "date-time",
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(
        value,
      ) && !Number.isNaN(Date.parse(value)),
  );
  validator = ajv.compile(schema);
  return validator;
}

/** Where an index breaks the vendored registry index schema; empty when it doesn't. */
export function schemaProblems(index) {
  const validate = schemaValidator();
  if (validate(index)) return [];
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath || "/"} ${error.message}`,
  );
}

/** Keeps the published updatedAt when nothing else in the index changed, so a rerun changes no file. */
export function keepTimestamp(next, previous) {
  if (!previous || typeof previous.updatedAt !== "string") return next;
  const same = isDeepStrictEqual(
    { ...next, updatedAt: "" },
    { ...previous, updatedAt: "" },
  );
  return same ? { ...next, updatedAt: previous.updatedAt } : next;
}

/** The sha256 hex the GitHub API reports for a release asset, or null. */
function assetSha256(asset) {
  return /^sha256:([0-9a-f]{64})$/.exec(asset?.digest ?? "")?.[1] ?? null;
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/*
 * The hourly shortcut (`--if-changed`) may skip downloading and verifying only
 * when every input that verification reads is byte for byte what the last
 * full run read. The script stores this record as inputs.json next to
 * index.json on the registry branch. Its parts:
 *
 * - releases: for each counted release (published, all three assets, not
 *   older than first-version.txt), the sha256 of its .tmxplug, .sig and
 *   .sigstore.json. Downloaded bytes when recorded, the API's asset digests
 *   when compared, so a replaced, added or removed asset or release, a draft
 *   flip or a missing digest all mean a full read.
 * - publicKey: registry/public-key.txt, which every .sig is checked against.
 * - since: registry/first-version.txt, which decides which releases count.
 * - tooling: a hash of the code and data that do the checks and write the
 *   index (these scripts, the vendored schema and the dependency versions
 *   they import), so changed rules re-read everything.
 * - index: the sha256 of the published index.json, so the shortcut never
 *   republishes an index that was changed on the branch by hand.
 */

const INPUTS_VERSION = 1;

function indexDigest(index) {
  return index ? sha256Hex(JSON.stringify(index)) : null;
}

function inputs({ releases, publicKey, since, tooling, index }) {
  const byTag = {};
  for (const { tag, digests } of releases) byTag[tag] = digests;
  return {
    version: INPUTS_VERSION,
    tooling,
    publicKey,
    since: since ?? null,
    index: indexDigest(index),
    releases: byTag,
  };
}

/**
 * The inputs record of a full run: ready is downloadReleases' list, whose
 * digests are of the bytes verification read; index is the one written.
 */
export function inputsRecord({ ready, publicKey, since, tooling, index }) {
  return inputs({
    releases: ready.map(({ release, digests }) => ({
      tag: release.tag_name,
      digests,
    })),
    publicKey,
    since,
    tooling,
    index,
  });
}

/**
 * The same record from the API's release listing, without downloading, or
 * null when a counted asset has no digest.
 */
function currentInputs({ releases, publicKey, since, tooling, index }) {
  const counted = [];
  for (const release of releases) {
    const { assets } = releaseAssets(release, { since });
    if (!assets) continue;
    const digests = {
      tmxplug: assetSha256(assets.artifact),
      sig: assetSha256(assets.sig),
      provenance: assetSha256(assets.provenance),
    };
    if (!digests.tmxplug || !digests.sig || !digests.provenance) return null;
    counted.push({ tag: release.tag_name, digests });
  }
  return inputs({ releases: counted, publicKey, since, tooling, index });
}

/**
 * True when nothing verification reads has changed since the full run that
 * wrote previousInputs (see the list above). now holds the release listing,
 * public key, first version, tooling hash and the published index.
 */
export function unchangedSince(previousInputs, now) {
  if (!previousInputs || !now?.index) return false;
  const current = currentInputs(now);
  return current !== null && isDeepStrictEqual(previousInputs, current);
}
