import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Fixtures for the registry index tests: throwaway keys and fake releases, made in memory. */

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SDK = path.join(ROOT, "node_modules", "@termix-ssh", "plugin-sdk");
export const CLI = path.join(SDK, "cli", "index.mjs");
export const REPOSITORY = "https://github.com/pacnpal/termix-coolify-plugin";

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

/** A fresh Ed25519 pair: the raw public key and the PKCS8 private key, both base64, as keygen writes them. */
export function testKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    publicKey: spki.subarray(spki.length - 32).toString("base64"),
    privateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  };
}

/** What `termix-plugin sign` writes to a .sig: Ed25519 over the raw sha256, base64, then a newline. */
export function sign(buffer: Buffer, privateKey: string): string {
  const key = crypto.createPrivateKey({
    key: Buffer.from(privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const digest = crypto.createHash("sha256").update(buffer).digest();
  return `${crypto.sign(null, digest, key).toString("base64")}\n`;
}

/** Runs the SDK's own CLI in a temporary folder and returns the folder. */
export function withTemp<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coolify-registry-"));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Signs a file with `termix-plugin sign` and returns the .sig it wrote. */
export function signWithCli(buffer: Buffer, privateKey: string): string {
  return withTemp((dir) => {
    const file = path.join(dir, "coolify-1.0.0.tmxplug");
    fs.writeFileSync(file, buffer);
    execFileSync(process.execPath, [CLI, "sign", file], {
      cwd: dir,
      env: { ...process.env, TERMIX_PLUGIN_SIGNING_KEY: privateKey },
      stdio: "pipe",
    });
    return fs.readFileSync(`${file}.sig`, "utf8");
  });
}

/** True when `termix-plugin verify` accepts the file and .sig with the key. */
export function verifiesWithCli(
  buffer: Buffer,
  sig: string,
  publicKey: string,
): boolean {
  return withTemp((dir) => {
    const file = path.join(dir, "coolify-1.0.0.tmxplug");
    fs.writeFileSync(file, buffer);
    fs.writeFileSync(`${file}.sig`, sig);
    try {
      execFileSync(
        process.execPath,
        [CLI, "verify", file, "--key", publicKey],
        {
          cwd: dir,
          stdio: "pipe",
        },
      );
      return true;
    } catch {
      return false;
    }
  });
}

export function manifestFor(
  version: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "coolify",
    name: "Coolify for Termix",
    version,
    description: "A test build of the plugin.",
    author: { name: "pacnpal", url: "https://github.com/pacnpal" },
    license: "Apache-2.0",
    repository: REPOSITORY,
    docs: `${REPOSITORY}/tree/main/docs`,
    category: "Infrastructure",
    icon: "Rocket",
    features: ["Connect Coolify", "Open shells"],
    engine: { termix: ">=26.11.2-0", api: "^2.7.0" },
    capabilities: ["db:own", "network:outbound"],
    contributes: { tabs: [], operations: [], commands: [] },
    ...overrides,
  };
}

const sdkPacker = import(
  pathToFileURL(path.join(SDK, "cli", "lib", "tmxplug.mjs")).href
);

/** A .tmxplug made by the SDK's own packer from a manifest and a CHANGELOG.md. */
export async function packPlugin(
  manifest: Record<string, unknown>,
  changelog?: string,
): Promise<Buffer> {
  const { createTmxplug, collectFiles } = await sdkPacker;
  return withTemp((dir) => {
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    if (changelog !== undefined)
      fs.writeFileSync(path.join(dir, "CHANGELOG.md"), changelog);
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(
      path.join(dir, "dist", "backend.js"),
      "export default {};\n",
    );
    return createTmxplug(dir, collectFiles(dir)) as Buffer;
  });
}

export function sha256Hex(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** A Sigstore bundle whose in-toto statement names the file and its sha256. */
export function provenanceFor(fileName: string, digestHex: string): string {
  const statement = {
    subject: [{ name: fileName, digest: { sha256: digestHex } }],
  };
  return JSON.stringify({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    dsseEnvelope: {
      payloadType: "application/vnd.in-toto+json",
      payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
      signatures: [],
    },
  });
}

export interface FakeAsset {
  name: string;
  size: number;
  browser_download_url: string;
  updated_at: string;
  /** What the GitHub API reports for an asset: sha256:<hex>. */
  digest?: string;
}

export interface FakeRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  published_at: string;
  assets: FakeAsset[];
}

export interface Built {
  release: FakeRelease;
  /** Every asset's bytes by download URL, for a fake download. */
  bodies: Map<string, Buffer>;
  artifact: Buffer;
}

function asset(tag: string, name: string, body: Buffer, at: string): FakeAsset {
  return {
    name,
    size: body.length,
    browser_download_url: `${REPOSITORY}/releases/download/${tag}/${name}`,
    updated_at: at,
    digest: `sha256:${sha256Hex(body)}`,
  };
}

export interface ReleaseOptions {
  keys: KeyPair;
  manifest?: Record<string, unknown>;
  changelog?: string;
  /** Asset kinds to leave off the release. */
  omit?: Array<"sig" | "provenance">;
  draft?: boolean;
  tag?: string;
  publishedAt?: string;
  /** Replaces the .sig text. */
  sig?: string;
  /** Replaces the provenance bundle text. */
  provenance?: string;
  /** Replaces the .tmxplug bytes after signing. */
  artifact?: (buffer: Buffer) => Buffer;
  /** Names the .tmxplug asset something other than <id>-<version>.tmxplug. */
  fileName?: string;
}

/** A published GitHub release of one version, signed by keys, with its asset bodies. */
export async function fakeRelease(
  version: string,
  options: ReleaseOptions,
): Promise<Built> {
  const manifest = options.manifest ?? manifestFor(version);
  const changelog =
    options.changelog ??
    `# Changelog\n\n## ${version}\n\n### Added\n\n- Notes for ${version}\n`;
  const packed = await packPlugin(manifest, changelog);
  const sig = options.sig ?? sign(packed, options.keys.privateKey);
  const artifact = options.artifact ? options.artifact(packed) : packed;
  const tag = options.tag ?? `v${version}`;
  const at = options.publishedAt ?? "2026-11-20T10:00:00Z";
  const fileName =
    options.fileName ??
    `${manifest.id as string}-${manifest.version as string}.tmxplug`;
  const provenance =
    options.provenance ?? provenanceFor(fileName, sha256Hex(artifact));

  const bodies = new Map<string, Buffer>();
  const assets: FakeAsset[] = [];
  const add = (name: string, body: Buffer) => {
    const entry = asset(tag, name, body, at);
    assets.push(entry);
    bodies.set(entry.browser_download_url, body);
  };
  add(fileName, artifact);
  if (!options.omit?.includes("sig")) add(`${fileName}.sig`, Buffer.from(sig));
  if (!options.omit?.includes("provenance"))
    add(`${fileName}.sigstore.json`, Buffer.from(provenance));

  return {
    release: {
      tag_name: tag,
      draft: options.draft ?? false,
      prerelease: version.includes("-"),
      html_url: `${REPOSITORY}/releases/tag/${tag}`,
      published_at: at,
      assets,
    },
    bodies,
    artifact,
  };
}

/** A download function over the bodies of several fake releases, recording each URL it was asked for. */
export function fakeDownload(built: Built[]) {
  const bodies = new Map<string, Buffer>();
  for (const one of built)
    for (const [url, body] of one.bodies) bodies.set(url, body);
  const asked: string[] = [];
  const download = async (url: string) => {
    asked.push(url);
    const body = bodies.get(url);
    if (!body) throw new Error(`no fake body for ${url}`);
    return body;
  };
  return { download, asked };
}
