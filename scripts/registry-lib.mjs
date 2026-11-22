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
/** The one plugin this registry lists. */
export const PLUGIN_ID = "coolify";

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
    const sizeField = field(124, 12).trim();
    if (!/^[0-7]*$/.test(sizeField)) {
      throw new Error(`The .tmxplug entry ${name} has a size that isn't octal`);
    }
    const size = Number.parseInt(sizeField || "0", 8);
    const start = offset + 512;
    const next = start + Math.ceil(size / 512) * 512;
    if (next > tar.length) {
      throw new Error(`The .tmxplug entry ${name} has a size past the archive`);
    }
    if (name === wanted) return tar.subarray(start, start + size);
    offset = next;
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

/** One release asset as the index and the checks use it. */
function assetFacts(asset) {
  return {
    name: asset.name,
    url: asset.browser_download_url,
    updatedAt: asset.updated_at ?? null,
  };
}

/**
 * Everything about a release, from the GitHub API, that ends up in index.json
 * or drives verification. readRelease reads a release only through these
 * facts, and the inputs record holds them whole, so a field the index starts
 * using is compared by the hourly shortcut too.
 */
function releaseFacts(release, assets) {
  return {
    tag: release.tag_name,
    draft: Boolean(release.draft),
    prerelease: Boolean(release.prerelease),
    htmlUrl: release.html_url ?? null,
    publishedAt: release.published_at ?? null,
    tmxplug: assetFacts(assets.artifact),
    sig: assetFacts(assets.sig),
    provenance: assetFacts(assets.provenance),
  };
}

/**
 * A published release's facts and the API's digests of its three assets, or
 * why it doesn't count. With since, a release older than that version was
 * signed by an earlier key and doesn't count either. A release with a
 * .tmxplug that is ambiguous (more than one), or not named
 * coolify-<tag version>.tmxplug, refuses the index rather than being skipped.
 */
export function releaseAssets(release, { since = null } = {}) {
  const tag = String(release.tag_name ?? "");
  if (release.draft) return { skip: "a draft" };
  const tagged = tag.startsWith("v") ? tag.slice(1) : "";
  const version = semver.valid(tagged) === tagged ? tagged : null;
  if (since && version && semver.lt(version, since)) {
    return {
      skip: `older than ${since}, the first version the current key signed`,
    };
  }
  const assets = release.assets ?? [];
  const tmxplugs = assets.filter((asset) => asset.name.endsWith(".tmxplug"));
  if (tmxplugs.length === 0) return { skip: "no .tmxplug" };
  if (tmxplugs.length > 1) {
    const names = tmxplugs.map((asset) => asset.name).sort(byCodeUnit);
    throw new Error(`${tag}: more than one .tmxplug (${names.join(", ")})`);
  }
  if (!version) throw new Error(`${tag}: the tag is not v<version>`);
  const expected = `${PLUGIN_ID}-${version}.tmxplug`;
  const [artifact] = tmxplugs;
  if (artifact.name !== expected) {
    throw new Error(
      `${tag}: the .tmxplug file name ${artifact.name} is not ${expected}, the name for the tag's version`,
    );
  }
  const sig = assets.find((asset) => asset.name === `${expected}.sig`);
  if (!sig) return { skip: `no ${expected}.sig` };
  const provenance = assets.find(
    (asset) => asset.name === `${expected}.sigstore.json`,
  );
  if (!provenance) return { skip: `no ${expected}.sigstore.json` };
  return {
    facts: releaseFacts(release, { artifact, sig, provenance }),
    apiDigests: {
      tmxplug: assetSha256(artifact),
      sig: assetSha256(sig),
      provenance: assetSha256(provenance),
    },
  };
}

/**
 * Downloads the three files of every release that counts. download(url)
 * resolves to a Buffer. Returns the downloaded releases and the skipped tags.
 */
export async function downloadReleases(releases, download, options = {}) {
  const ready = [];
  const skipped = [];
  for (const release of releases) {
    const { facts, skip } = releaseAssets(release, options);
    if (!facts) {
      skipped.push({ tag: release.tag_name, reason: skip });
      continue;
    }
    const artifact = await download(facts.tmxplug.url);
    const sigBytes = await download(facts.sig.url);
    const provenanceBytes = await download(facts.provenance.url);
    ready.push({
      facts,
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
/**
 * The manifest's engine ranges, or why they can't be used. A range semver
 * can't parse would make needsNewerCore answer false and put the release in
 * the list Termix 26.10.2 reads without checking, so it refuses the index.
 */
function engineOf(manifest) {
  const { api, termix } = manifest.engine ?? {};
  if (typeof api !== "string" || typeof termix !== "string") {
    return {
      problem: "the manifest has no engine.api and engine.termix ranges",
    };
  }
  for (const [name, range] of [
    ["engine.termix", termix],
    ["engine.api", api],
  ]) {
    if (range.trim() === "" || semver.validRange(range) === null) {
      return {
        problem: `the manifest ${name} ${JSON.stringify(range)} is not a semver range`,
      };
    }
  }
  return { engine: { api, termix } };
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
function readRelease({ facts, files }, publicKey, repository) {
  const where = facts.tag;
  const { artifact } = files;
  if (!verifySignature(artifact, files.sig, publicKey)) {
    throw new Error(
      `${where}: the signature in ${facts.sig.name} does not match registry/public-key.txt`,
    );
  }
  const raw = readTmxplugFile(artifact, "manifest.json");
  if (!raw)
    throw new Error(`${where}: no manifest.json in ${facts.tmxplug.name}`);
  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(
      `${where}: manifest.json in ${facts.tmxplug.name} is not valid JSON`,
    );
  }
  if (
    typeof manifest.version !== "string" ||
    semver.valid(manifest.version) !== manifest.version
  ) {
    throw new Error(`${where}: the manifest version is not a semver version`);
  }
  if (`v${manifest.version}` !== facts.tag) {
    throw new Error(`${where}: the manifest version is ${manifest.version}`);
  }
  if (manifest.id !== PLUGIN_ID) {
    throw new Error(
      `${where}: the plugin id in the manifest is ${manifest.id}, not ${PLUGIN_ID}`,
    );
  }
  if (facts.tmxplug.name !== `${manifest.id}-${manifest.version}.tmxplug`) {
    throw new Error(
      `${where}: the file name ${facts.tmxplug.name} is not ${manifest.id}-${manifest.version}.tmxplug`,
    );
  }
  if (manifest.repository !== repository) {
    throw new Error(`${where}: the manifest repository is not ${repository}`);
  }
  const { engine, problem } = engineOf(manifest);
  if (problem) throw new Error(`${where}: ${problem}`);
  const sha256 = crypto.createHash("sha256").update(artifact).digest("hex");
  if (!bundleDescribes(files.provenance, facts.tmxplug.name, sha256)) {
    throw new Error(
      `${where}: the provenance bundle ${facts.provenance.name} is not for this file`,
    );
  }
  const changelog = readTmxplugFile(artifact, "CHANGELOG.md");
  const notes = changelog
    ? changelogSection(changelog.toString("utf8"), manifest.version)
    : null;
  const entry = {
    version: manifest.version,
    api: engine.api.match(/\d+/)?.[0] ?? "",
    url: facts.tmxplug.url,
    sha256,
    signature: String(files.sig).trim(),
    size: artifact.length,
    capabilities: manifest.capabilities ?? [],
    engine,
    ...(manifest.dependencies && Object.keys(manifest.dependencies).length > 0
      ? { dependencies: manifest.dependencies }
      : {}),
    releaseNotesUrl: facts.htmlUrl,
    ...(notes ? { notes: notes.slice(0, 20_000) } : {}),
    provenance: { url: facts.provenance.url },
    // The asset upload time, which is the release date.
    publishedAt: new Date(
      facts.tmxplug.updatedAt ?? facts.publishedAt,
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
 * when every input that verification reads, and every release field that ends
 * up in index.json, is byte for byte what the last full run used. The script
 * stores this record as inputs.json next to index.json on the registry
 * branch. Its parts:
 *
 * - releases: for each counted release (published, all three assets, not
 *   older than first-version.txt), its releaseFacts (tag, draft and
 *   prerelease flags, release page, publish date, and each asset's name,
 *   download URL and upload time) and the sha256 of its .tmxplug, .sig and
 *   .sigstore.json. The facts are the only release data readRelease sees, so
 *   anything new the index shows is compared too. Digests are of the
 *   downloaded bytes when recorded and the API's asset digests when compared;
 *   a missing digest means a full read.
 * - repository: the repo the manifests must name and the index links to.
 * - publicKey: registry/public-key.txt, which every .sig is checked against.
 * - since: registry/first-version.txt, which decides which releases count.
 * - tooling: a hash of the code and data that do the checks and write the
 *   index (these scripts, the vendored schema and the dependency versions
 *   they import), so changed rules re-read everything.
 * - index: the sha256 of the published index.json, so the shortcut never
 *   republishes an index that was changed on the branch by hand.
 */

const INPUTS_VERSION = 2;

function indexDigest(index) {
  return index ? sha256Hex(JSON.stringify(index)) : null;
}

function inputs({ releases, repository, publicKey, since, tooling, index }) {
  return {
    version: INPUTS_VERSION,
    tooling,
    repository,
    publicKey,
    since: since ?? null,
    index: indexDigest(index),
    // One entry per counted release, in a fixed order.
    releases: releases
      .map(({ facts, digests }) => ({ facts, digests }))
      .sort((a, b) => byCodeUnit(a.facts.tag, b.facts.tag)),
  };
}

/**
 * The inputs record of a full run: ready is downloadReleases' list, whose
 * facts the index was built from and whose digests are of the bytes
 * verification read; index is the one written.
 */
export function inputsRecord({
  ready,
  repository,
  publicKey,
  since,
  tooling,
  index,
}) {
  return inputs({
    releases: ready,
    repository,
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
function currentInputs({
  releases,
  repository,
  publicKey,
  since,
  tooling,
  index,
}) {
  const counted = [];
  for (const release of releases) {
    const { facts, apiDigests } = releaseAssets(release, { since });
    if (!facts) continue;
    if (!apiDigests.tmxplug || !apiDigests.sig || !apiDigests.provenance) {
      return null;
    }
    counted.push({ facts, digests: apiDigests });
  }
  return inputs({
    releases: counted,
    repository,
    publicKey,
    since,
    tooling,
    index,
  });
}

/**
 * True when nothing verification reads or the index shows has changed since
 * the full run that wrote previousInputs (see the list above). now holds the
 * release listing, repository, public key, first version, tooling hash and
 * the published index. A listing that refuses the index (an ambiguous
 * .tmxplug) is never unchanged.
 */
export function unchangedSince(previousInputs, now) {
  if (!previousInputs || !now?.index) return false;
  let current;
  try {
    current = currentInputs(now);
  } catch {
    return false;
  }
  return current !== null && isDeepStrictEqual(previousInputs, current);
}

/**
 * The previous index, when it is one this registry could have written: an
 * object that matches the registry index schema with this registry's id.
 * Anything else is treated as absent, so it is never reused or kept from.
 */
export function usablePrevious(index) {
  if (!index || typeof index !== "object" || Array.isArray(index)) return null;
  if (index.registry !== REGISTRY_ID) return null;
  return schemaProblems(index).length === 0 ? index : null;
}

/**
 * A response body as a Buffer, read chunk by chunk and cancelled as soon as
 * it passes limit bytes, so an oversized asset is never held whole.
 */
export async function readLimited(response, limit, label) {
  const tooBig = () => new Error(`${label} is larger than ${limit} bytes`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw tooBig();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
