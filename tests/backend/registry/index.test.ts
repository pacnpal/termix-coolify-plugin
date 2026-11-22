import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  REGISTRY_ID,
  REGISTRY_NAME,
  buildIndex,
  downloadReleases,
  keepTimestamp,
  keyIdOf,
  listReleases,
  parseFirstVersion,
  parsePublicKey,
  placeReleases,
  readTmxplugFile,
  readLimited,
  usablePrevious,
  cutAtNul,
  byCodeUnit,
  schemaProblems,
  inputsRecord,
  unchangedSince,
  verifySignature,
} from "../../../scripts/registry-lib.mjs";
import { growth, LINEAR_GROWTH } from "../../shared/linear-cost.js";
import {
  type Built,
  type KeyPair,
  REPOSITORY,
  ROOT,
  fakeDownload,
  fakeRelease,
  manifestFor,
  packPlugin,
  provenanceFor,
  sha256Hex,
  sign,
  signWithCli,
  testKeyPair,
  verifiesWithCli,
  withTemp,
} from "./fixtures";
import { HEAVY_TEST_MS } from "../../shared/timing.js";

const UPDATED_AT = "2026-11-22T12:00:00.000Z";
const TOOLING = "test-tooling";

/** Builds the index the way the script does: download what is complete, then build. */
async function indexOf(built: Built[], publicKey: string) {
  const { download } = fakeDownload(built);
  const { ready } = await downloadReleases(
    built.map((one) => one.release),
    download,
  );
  return buildIndex({
    releases: ready,
    publicKey,
    repository: REPOSITORY,
    updatedAt: UPDATED_AT,
  });
}

describe("parsePublicKey", () => {
  it("reads one line of base64 and gives the key id Termix shows", () => {
    const keys = testKeyPair();
    const parsed = parsePublicKey(`${keys.publicKey}\n`);
    expect(parsed.publicKey).toBe(keys.publicKey);
    expect(parsed.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(parsed.keyId).toBe(keyIdOf(keys.publicKey));
  });

  it("refuses anything that is not a single 32 byte public key", () => {
    const keys = testKeyPair();
    for (const bad of [
      "",
      "\n",
      `${keys.publicKey}\n${keys.publicKey}`,
      keys.privateKey,
      keys.publicKey.slice(0, 40),
      "not base64 at all!",
      "-----BEGIN PUBLIC KEY-----",
    ]) {
      expect(() => parsePublicKey(bad), JSON.stringify(bad)).toThrow(
        /public key/,
      );
    }
  });
});

describe("verifySignature", () => {
  it("accepts what termix-plugin sign writes and agrees with termix-plugin verify", async () => {
    const keys = testKeyPair();
    const other = testKeyPair();
    const file = await packPlugin(
      manifestFor("1.0.0"),
      "# Changelog\n\n## 1.0.0\n\n### Added\n\n- One\n",
    );
    const sig = signWithCli(file, keys.privateKey);
    expect(sig).toBe(sign(file, keys.privateKey));

    expect(verifySignature(file, sig, keys.publicKey)).toBe(true);
    expect(verifiesWithCli(file, sig, keys.publicKey)).toBe(true);

    expect(verifySignature(file, sig, other.publicKey)).toBe(false);
    expect(verifiesWithCli(file, sig, other.publicKey)).toBe(false);

    const tampered = Buffer.concat([file, Buffer.from([0])]);
    expect(verifySignature(tampered, sig, keys.publicKey)).toBe(false);
    expect(verifiesWithCli(tampered, sig, keys.publicKey)).toBe(false);
  });

  it("refuses an envelope or a malformed signature", async () => {
    const keys = testKeyPair();
    const file = await packPlugin(manifestFor("1.0.0"));
    const sig = sign(file, keys.privateKey).trim();
    expect(
      verifySignature(
        file,
        JSON.stringify({ keyId: "0123456789abcdef", sig }),
        keys.publicKey,
      ),
    ).toBe(false);
    expect(verifySignature(file, sig.slice(0, 40), keys.publicKey)).toBe(false);
    expect(verifySignature(file, "", keys.publicKey)).toBe(false);
  });
});

describe("cutAtNul", () => {
  // The pattern readTmxplugFile used before: everything from the first NUL on.
  const OLD = (value: string) => value.replace(/\0.*$/s, "");
  const cases = [
    "",
    "\0",
    "\0\0\0",
    "name",
    "name\0",
    "name\0\0\0\0",
    "name\0junk",
    "name\0junk\0more",
    "\0leading",
    "a\nb\0c\nd",
    "line\nbreak",
    "multi\r\nline\0\r\ntail",
    "ustar\u0000\u0000",
    "é\0é",
    "0000644\0",
    "\0".repeat(5) + "x",
  ];

  it("keeps exactly what the old pattern kept", () => {
    for (const value of cases) {
      expect(cutAtNul(value), JSON.stringify(value)).toBe(OLD(value));
    }
  });

  // Fixed work: growth() samples each size for 25 clock steps, a few tenths
  // of a second of CPU; an explicit timeout keeps a busy machine from failing
  // it on Vitest's 5 s (#105).
  it(
    "stays linear on long hostile input",
    () => {
      const inputs = (scale: number) => [
        "a".repeat(2_000_000 * scale),
        "\n".repeat(2_000_000 * scale),
        "a".repeat(1_000_000 * scale) + "\0" + "\0b".repeat(500_000 * scale),
        "\0\n".repeat(1_000_000 * scale),
      ];
      for (const value of inputs(1)) expect(cutAtNul(value)).toBe(OLD(value));
      // Growth, not milliseconds: load can't fail it (#105). Measured from an
      // eighth of these inputs up: the full ones (6 MB) spill out of the CPU's
      // caches, where even a plain scan slows down by itself.
      const grew = growth((scale) => {
        const values = inputs(scale / 8);
        return () => values.map((value) => cutAtNul(value));
      });
      expect(grew).toBeLessThan(LINEAR_GROWTH);
    },
    HEAVY_TEST_MS,
  );
});

describe("readTmxplugFile", () => {
  it("reads the manifest and changelog out of a .tmxplug the SDK packed", async () => {
    const file = await packPlugin(manifestFor("1.2.3"), "# Changelog\n");
    expect(
      JSON.parse(readTmxplugFile(file, "manifest.json")!.toString("utf8"))
        .version,
    ).toBe("1.2.3");
    expect(readTmxplugFile(file, "CHANGELOG.md")!.toString("utf8")).toBe(
      "# Changelog\n",
    );
    expect(readTmxplugFile(file, "missing.json")).toBeNull();
  });

  /** The archive with the first entry's size field replaced. */
  function withSize(file: Buffer, size: string): Buffer {
    const tar = Buffer.from(gunzipSync(file));
    tar.write(size.padEnd(12, "\0").slice(0, 12), 124, "latin1");
    return gzipSync(tar);
  }

  it("refuses an entry size that isn't octal or runs past the archive", async () => {
    const file = await packPlugin(manifestFor("1.2.3"), "# Changelog\n");
    for (const size of [
      "99999999999",
      "zzzzzzzzzzz",
      "-0000000001",
      "77777777777",
      "00000777777",
    ]) {
      expect(
        () => readTmxplugFile(withSize(file, size), "manifest.json"),
        size,
      ).toThrow(/size/);
    }
  });

  it("still steps over a zero-length entry", async () => {
    const file = await packPlugin(manifestFor("1.2.3"), undefined, {
      "empty.js": "",
    });
    expect(readTmxplugFile(file, "dist/empty.js")!.length).toBe(0);
    expect(
      JSON.parse(readTmxplugFile(file, "manifest.json")!.toString("utf8"))
        .version,
    ).toBe("1.2.3");
  });
});

describe("readLimited", () => {
  /** A body of chunk-sized pieces, counting how many were pulled and whether it was cancelled. */
  function body(
    chunks: number,
    chunkSize: number,
    headers: Record<string, string> = {},
  ) {
    const state = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.pulled >= chunks) return controller.close();
        state.pulled++;
        controller.enqueue(new Uint8Array(chunkSize).fill(7));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { response: new Response(stream, { headers }), state };
  }

  it("returns the whole body when it fits", async () => {
    const { response } = body(4, 1000);
    const buffer = await readLimited(response, 4000, "small.tmxplug");
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBe(4000);
  });

  it("stops reading and cancels as soon as the body passes the limit", async () => {
    const { response, state } = body(10_000, 1024);
    await expect(
      readLimited(response, 8 * 1024, "big.tmxplug"),
    ).rejects.toThrow(/big\.tmxplug is larger than 8192 bytes/);
    expect(state.pulled).toBeLessThan(12);
    expect(state.cancelled).toBe(true);
  });

  it("refuses a declared length over the limit before reading", async () => {
    const { response, state } = body(10, 1024, { "content-length": "999999" });
    await expect(
      readLimited(response, 8 * 1024, "declared.tmxplug"),
    ).rejects.toThrow(/declared\.tmxplug is larger/);
    expect(state.pulled).toBeLessThanOrEqual(1);
  });
});

describe("usablePrevious", () => {
  it("keeps a valid index of this registry and drops anything else", async () => {
    const keys = testKeyPair();
    const index = await indexOf(
      [await fakeRelease("1.0.0", { keys })],
      keys.publicKey,
    );
    expect(usablePrevious(structuredClone(index))).toEqual(index);
    expect(
      usablePrevious({ ...structuredClone(index), updatedAt: "not-a-date" }),
    ).toBeNull();
    expect(
      usablePrevious({ ...structuredClone(index), registry: "someone-else" }),
    ).toBeNull();
    const broken = structuredClone(index);
    broken.plugins[0].gated[0].sha256 = "nope";
    expect(usablePrevious(broken)).toBeNull();
    for (const junk of [null, undefined, 3, "index", [], {}]) {
      expect(usablePrevious(junk), JSON.stringify(junk)).toBeNull();
    }
  });
});

describe("byCodeUnit", () => {
  it("orders strings by UTF-16 code unit, not by locale", () => {
    expect(["b", "C", "a", "Alpha", "alpha"].sort(byCodeUnit)).toEqual([
      "Alpha",
      "C",
      "a",
      "alpha",
      "b",
    ]);
    expect(byCodeUnit("a", "a")).toBe(0);
  });

  it("sorts what a plugin contributes the same way in the index", async () => {
    const keys = testKeyPair();
    const built = await fakeRelease("1.0.0", {
      keys,
      manifest: manifestFor("1.0.0", {
        contributes: { tabs: [], Zed: [], commands: [] },
      }),
    });
    const [plugin] = (await indexOf([built], keys.publicKey)).plugins;
    expect(plugin.contributes).toEqual(["Zed", "commands", "tabs"]);
  });
});

describe("placeReleases", () => {
  const entry = (version: string, termix: string) => ({
    version,
    engine: { api: "^2.7.0", termix },
  });

  it("gates releases Termix 26.10.2 can't run, lists betas only while newer than stable", () => {
    const placed = placeReleases({
      id: "coolify",
      versions: [
        entry("0.9.0", ">=26.0.0"),
        entry("1.0.0", ">=26.11.2-0"),
        entry("0.8.0", ">=26.0.0"),
        entry("1.2.0-beta.1", ">=26.0.0"),
        entry("1.1.0-beta.1", ">=26.11.2-0"),
        entry("0.9.0-beta.3", ">=26.0.0"),
      ],
    });
    expect(placed.versions.map((r) => r.version)).toEqual(["0.9.0", "0.8.0"]);
    expect(placed.prereleases.map((r) => r.version)).toEqual(["1.2.0-beta.1"]);
    expect(placed.gated.map((r) => r.version)).toEqual([
      "1.1.0-beta.1",
      "1.0.0",
    ]);
  });

  it("leaves out empty prereleases and gated lists", () => {
    const placed = placeReleases({
      id: "coolify",
      versions: [entry("1.0.0", ">=26.0.0")],
    });
    expect(placed).toEqual({
      id: "coolify",
      versions: [entry("1.0.0", ">=26.0.0")],
    });
  });
});

describe("downloadReleases", () => {
  it("downloads only published releases with a .tmxplug, .sig and provenance bundle", async () => {
    const keys = testKeyPair();
    const complete = await fakeRelease("1.0.0", { keys });
    const draft = await fakeRelease("1.1.0", { keys, draft: true });
    const unsigned = await fakeRelease("0.9.0", { keys, omit: ["sig"] });
    const noProvenance = await fakeRelease("0.8.0", {
      keys,
      omit: ["provenance"],
    });
    const { download, asked } = fakeDownload([
      complete,
      draft,
      unsigned,
      noProvenance,
    ]);

    const { ready, skipped } = await downloadReleases(
      [complete, draft, unsigned, noProvenance].map((one) => one.release),
      download,
    );

    expect(ready.map((one) => one.facts.tag)).toEqual(["v1.0.0"]);
    expect(ready[0].files.artifact.equals(complete.artifact)).toBe(true);
    expect(ready[0].files.sig).toBe(sign(complete.artifact, keys.privateKey));
    expect(skipped.map((one) => one.tag)).toEqual([
      "v1.1.0",
      "v0.9.0",
      "v0.8.0",
    ]);
    expect(asked.every((url) => url.includes("/v1.0.0/"))).toBe(true);
  });
});

describe("a rotated key (registry/first-version.txt)", () => {
  it("never reads releases older than the first version the current key signed", async () => {
    const oldKeys = testKeyPair();
    const keys = testKeyPair();
    const before = await fakeRelease("1.0.0", { keys: oldKeys });
    const beta = await fakeRelease("1.1.0-beta.1", { keys: oldKeys });
    const after = await fakeRelease("1.1.0", { keys });
    const all = [before, beta, after];
    const { download, asked } = fakeDownload(all);

    // Without a cutoff the old key's releases refuse the whole index.
    const unfenced = await downloadReleases(
      all.map((one) => one.release),
      download,
    );
    expect(() =>
      buildIndex({
        releases: unfenced.ready,
        publicKey: keys.publicKey,
        repository: REPOSITORY,
        updatedAt: UPDATED_AT,
      }),
    ).toThrow(/signature/);

    asked.length = 0;
    const { ready, skipped } = await downloadReleases(
      all.map((one) => one.release),
      download,
      { since: "1.1.0" },
    );
    expect(ready.map((one) => one.facts.tag)).toEqual(["v1.1.0"]);
    expect(skipped.map((one) => one.tag)).toEqual(["v1.0.0", "v1.1.0-beta.1"]);
    expect(skipped[0].reason).toMatch(/1\.1\.0/);
    expect(asked.every((url) => url.includes("/v1.1.0/"))).toBe(true);

    const index = buildIndex({
      releases: ready,
      publicKey: keys.publicKey,
      repository: REPOSITORY,
      updatedAt: UPDATED_AT,
    });
    expect(index.plugins[0].gated.map((r) => r.version)).toEqual(["1.1.0"]);
    const inputs = inputsRecord({
      ready,
      publicKey: keys.publicKey,
      since: "1.1.0",
      tooling: TOOLING,
      repository: REPOSITORY,
      index,
    });
    const now = {
      releases: all.map((one) => one.release),
      publicKey: keys.publicKey,
      tooling: TOOLING,
      repository: REPOSITORY,
      index,
    };
    expect(unchangedSince(inputs, { ...now, since: "1.1.0" })).toBe(true);
    // Dropping or moving first-version.txt is a change.
    expect(unchangedSince(inputs, { ...now, since: null })).toBe(false);
    expect(unchangedSince(inputs, { ...now, since: "1.0.0" })).toBe(false);
  });

  it("reads first-version.txt as one semver version, or nothing when it is absent", () => {
    expect(parseFirstVersion(undefined)).toBeNull();
    expect(parseFirstVersion("1.1.0\n")).toBe("1.1.0");
    expect(() => parseFirstVersion("v1.1")).toThrow(/first-version/);
    expect(() => parseFirstVersion("1.1.0\n1.2.0")).toThrow(/first-version/);
  });
});

describe("listReleases", () => {
  it("reads every page of releases", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => ({ tag_name: `v0.0.${i}` })),
      [{ tag_name: "v1.0.0" }],
    ];
    const asked: string[] = [];
    const releases = await listReleases(async (url: string) => {
      asked.push(url);
      return pages[asked.length - 1] ?? [];
    }, "pacnpal/termix-coolify-plugin");
    expect(releases).toHaveLength(101);
    expect(asked).toEqual([
      "/repos/pacnpal/termix-coolify-plugin/releases?per_page=100&page=1",
      "/repos/pacnpal/termix-coolify-plugin/releases?per_page=100&page=2",
    ]);
  });
});

describe("buildIndex", () => {
  it("lists each signed release with what the official registry fills in", async () => {
    const keys = testKeyPair();
    const stable = await fakeRelease("1.0.0", {
      keys,
      publishedAt: "2026-11-20T10:00:00Z",
    });
    const index = await indexOf([stable], keys.publicKey);

    expect(index).toMatchObject({
      registry: REGISTRY_ID,
      name: REGISTRY_NAME,
      apiVersion: 1,
      publicKey: keys.publicKey,
      updatedAt: UPDATED_AT,
    });
    expect(REGISTRY_ID).toBe("pacnpal-coolify");
    expect(REGISTRY_NAME).toBe("Coolify for Termix (pacnpal)");
    expect(index.plugins).toHaveLength(1);
    const [plugin] = index.plugins;
    expect(plugin).toMatchObject({
      id: "coolify",
      name: "Coolify for Termix",
      description: "A test build of the plugin.",
      author: "pacnpal",
      category: "Infrastructure",
      repository: REPOSITORY,
      icon: "Rocket",
      features: ["Connect Coolify", "Open shells"],
      docs: `${REPOSITORY}/tree/main/docs`,
      contributes: ["commands", "operations", "tabs"],
      versions: [],
    });
    // engine.termix >=26.11.2-0: Termix 26.10.2 can't run it, so it is gated.
    expect(plugin.gated).toHaveLength(1);
    const [version] = plugin.gated;
    const url = `${REPOSITORY}/releases/download/v1.0.0/coolify-1.0.0.tmxplug`;
    expect(version).toEqual({
      version: "1.0.0",
      api: "2",
      url,
      sha256: sha256Hex(stable.artifact),
      signature: sign(stable.artifact, keys.privateKey).trim(),
      size: stable.artifact.length,
      capabilities: ["db:own", "network:outbound"],
      engine: { api: "^2.7.0", termix: ">=26.11.2-0" },
      releaseNotesUrl: `${REPOSITORY}/releases/tag/v1.0.0`,
      notes: "### Added\n\n- Notes for 1.0.0",
      provenance: { url: `${url}.sigstore.json` },
      publishedAt: "2026-11-20T10:00:00.000Z",
    });
  });

  it("sorts stable, beta and gated releases like the official registry", async () => {
    const keys = testKeyPair();
    const older = { engine: { termix: ">=26.0.0", api: "^2.7.0" } };
    const built = await Promise.all([
      fakeRelease("0.9.0", { keys, manifest: manifestFor("0.9.0", older) }),
      fakeRelease("1.0.0", { keys }),
      fakeRelease("1.1.0-beta.2", { keys }),
      fakeRelease("1.2.0-beta.1", {
        keys,
        manifest: manifestFor("1.2.0-beta.1", older),
      }),
      fakeRelease("0.9.0-beta.1", {
        keys,
        manifest: manifestFor("0.9.0-beta.1", older),
      }),
    ]);
    const [plugin] = (await indexOf(built, keys.publicKey)).plugins;
    expect(plugin.versions.map((r) => r.version)).toEqual(["0.9.0"]);
    expect(plugin.prereleases.map((r) => r.version)).toEqual(["1.2.0-beta.1"]);
    expect(plugin.gated.map((r) => r.version)).toEqual([
      "1.1.0-beta.2",
      "1.0.0",
    ]);
  });

  it("takes the listing from the newest stable release, not a beta", async () => {
    const keys = testKeyPair();
    const built = await Promise.all([
      fakeRelease("1.0.0", {
        keys,
        manifest: manifestFor("1.0.0", { description: "Stable text." }),
      }),
      fakeRelease("1.1.0-beta.1", {
        keys,
        manifest: manifestFor("1.1.0-beta.1", { description: "Beta text." }),
      }),
    ]);
    const [plugin] = (await indexOf(built, keys.publicKey)).plugins;
    expect(plugin.description).toBe("Stable text.");
  });

  it("writes an empty registry when nothing is released yet", async () => {
    const keys = testKeyPair();
    const index = await indexOf([], keys.publicKey);
    expect(index.plugins).toEqual([]);
    expect(schemaProblems(index)).toEqual([]);
  });

  it("publishes the empty registry with the committed key, and the next hourly run keeps it", async () => {
    const publicKey = fs
      .readFileSync(path.join(ROOT, "registry", "public-key.txt"), "utf8")
      .trim();
    // No releases yet, and ones without a .sig never count.
    const unsigned = await fakeRelease("1.0.0", {
      keys: testKeyPair(),
      omit: ["sig"],
    });
    const { download } = fakeDownload([unsigned]);
    const { ready } = await downloadReleases([unsigned.release], download);
    const index = buildIndex({
      releases: ready,
      publicKey,
      repository: REPOSITORY,
      updatedAt: UPDATED_AT,
    });
    expect(index).toEqual({
      registry: "pacnpal-coolify",
      name: "Coolify for Termix (pacnpal)",
      apiVersion: 1,
      publicKey,
      updatedAt: UPDATED_AT,
      plugins: [],
    });
    expect(schemaProblems(index)).toEqual([]);

    const inputs = inputsRecord({
      ready,
      publicKey,
      since: null,
      tooling: TOOLING,
      repository: REPOSITORY,
      index,
    });
    const now = {
      releases: [unsigned.release],
      publicKey,
      since: null,
      tooling: TOOLING,
      repository: REPOSITORY,
      index: JSON.parse(JSON.stringify(index)),
    };
    expect(unchangedSince(JSON.parse(JSON.stringify(inputs)), now)).toBe(true);
  });

  describe("refuses the whole index", () => {
    const refusals: Array<[string, RegExp, (keys: KeyPair) => Promise<Built>]> =
      [
        [
          "a release signed by another key",
          /signature/,
          (keys) =>
            fakeRelease("1.0.0", {
              keys: { ...testKeyPair(), publicKey: keys.publicKey },
            }),
        ],
        [
          "a file changed after signing",
          /signature/,
          (keys) =>
            fakeRelease("1.0.0", {
              keys,
              artifact: (b) => Buffer.concat([b, Buffer.from([1])]),
            }),
        ],
        [
          "a chain envelope in the .sig",
          /signature/,
          (keys) =>
            fakeRelease("1.0.0", {
              keys,
              sig: '{"keyId":"0123456789abcdef","sig":"x"}',
            }),
        ],
        [
          "a tag whose version the .tmxplug name doesn't carry",
          /^(?:(?!file name).)*file name.*version/m,
          (keys) => fakeRelease("1.0.0", { keys, tag: "v1.0.1" }),
        ],
        [
          "a manifest whose version is not the tag's",
          /manifest version/,
          (keys) =>
            fakeRelease("1.0.0", {
              keys,
              tag: "v1.0.1",
              fileName: "coolify-1.0.1.tmxplug",
            }),
        ],
        [
          "a tag that is not v<version>",
          /tag/,
          (keys) => fakeRelease("1.0.0", { keys, tag: "nightly" }),
        ],
        [
          "an extra .tmxplug on the release",
          /more than one \.tmxplug/,
          (keys) =>
            fakeRelease("1.0.0", {
              keys,
              extraAssets: [
                { name: "other-1.0.0.tmxplug", body: Buffer.from("x") },
              ],
            }),
        ],
        [
          "an unrelated .tmxplug listed before the right one",
          /more than one \.tmxplug/,
          async (keys) => {
            const built = await fakeRelease("1.0.0", {
              keys,
              extraAssets: [
                { name: "aaa-1.0.0.tmxplug", body: Buffer.from("x") },
              ],
            });
            built.release.assets.unshift(built.release.assets.pop()!);
            return built;
          },
        ],
        [
          "a malformed engine.termix range",
          /engine\.termix/,
          (keys) =>
            fakeRelease("1.0.0", {
              keys,
              manifest: manifestFor("1.0.0", {
                engine: { termix: "26.11.2 or newer", api: "^2.7.0" },
              }),
            }),
        ],
        [
          "a malformed engine.api range",
          /engine\.api/,
          (keys) =>
            fakeRelease("1.0.0", {
              keys,
              manifest: manifestFor("1.0.0", {
                engine: { termix: ">=26.11.2-0", api: "two" },
              }),
            }),
        ],
        [
          "a file not named <id>-<version>.tmxplug",
          /file name/,
          (keys) =>
            fakeRelease("1.0.0", { keys, fileName: "renamed-1.0.0.tmxplug" }),
        ],
        [
          "a manifest from another repository",
          /repository/,
          (keys) =>
            fakeRelease("1.0.0", {
              keys,
              manifest: manifestFor("1.0.0", {
                repository: "https://github.com/someone/else",
              }),
            }),
        ],
        [
          "a provenance bundle for another file",
          /provenance/,
          (keys) =>
            fakeRelease("1.0.0", {
              keys,
              provenance: provenanceFor(
                "coolify-1.0.0.tmxplug",
                "0".repeat(64),
              ),
            }),
        ],
        [
          "a provenance bundle that is not JSON",
          /provenance/,
          (keys) => fakeRelease("1.0.0", { keys, provenance: "nope" }),
        ],
        [
          "a manifest without engine ranges",
          /engine/,
          (keys) =>
            fakeRelease("1.0.0", {
              keys,
              manifest: manifestFor("1.0.0", { engine: undefined }),
            }),
        ],
        [
          "two releases of the same version",
          /twice/,
          (keys) => fakeRelease("0.9.0", { keys }),
        ],
      ];

    for (const [name, message, make] of refusals) {
      it(name, async () => {
        const keys = testKeyPair();
        const good = await fakeRelease("0.9.0", { keys });
        // The good release alone builds, so the refusal is the bad one's.
        await expect(indexOf([good], keys.publicKey)).resolves.toBeTruthy();
        const bad = await make(keys);
        await expect(indexOf([good, bad], keys.publicKey)).rejects.toThrow(
          message,
        );
      });
    }

    it("a release of another plugin id", async () => {
      const keys = testKeyPair();
      const good = await fakeRelease("1.0.0", { keys });
      const other = await fakeRelease("1.1.0", {
        keys,
        manifest: manifestFor("1.1.0", { id: "other" }),
        fileName: "coolify-1.1.0.tmxplug",
      });
      await expect(indexOf([good], keys.publicKey)).resolves.toBeTruthy();
      await expect(indexOf([good, other], keys.publicKey)).rejects.toThrow(
        "the plugin id in the manifest is other, not coolify",
      );
    });

    it("an invalid registry key", async () => {
      const keys = testKeyPair();
      const good = await fakeRelease("1.0.0", { keys });
      await expect(indexOf([good], keys.privateKey)).rejects.toThrow(
        /public key/,
      );
    });
  });
});

describe("schemaProblems", () => {
  it("passes a built index and fails a broken one against the vendored schema", async () => {
    const keys = testKeyPair();
    const built = await Promise.all([
      fakeRelease("1.0.0", { keys }),
      fakeRelease("1.1.0-beta.1", { keys }),
      fakeRelease("0.9.0", {
        keys,
        manifest: manifestFor("0.9.0", {
          engine: { termix: ">=26.0.0", api: "^2.7.0" },
        }),
      }),
    ]);
    const index = await indexOf(built, keys.publicKey);
    expect(schemaProblems(index)).toEqual([]);

    const broken = structuredClone(index);
    broken.plugins[0].versions[0].sha256 = "not a digest";
    delete (broken as { registry?: string }).registry;
    expect(schemaProblems(broken).length).toBeGreaterThanOrEqual(2);
  });
});

describe("keepTimestamp", () => {
  it("keeps the published updatedAt when nothing else changed", async () => {
    const keys = testKeyPair();
    const index = await indexOf(
      [await fakeRelease("1.0.0", { keys })],
      keys.publicKey,
    );
    const previous = {
      ...structuredClone(index),
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    expect(keepTimestamp(index, previous).updatedAt).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    expect(keepTimestamp(index, null).updatedAt).toBe(UPDATED_AT);

    const changed = structuredClone(previous);
    changed.plugins[0].gated[0].notes = "Older notes";
    expect(keepTimestamp(index, changed).updatedAt).toBe(UPDATED_AT);
  });
});

describe("unchangedSince", () => {
  /** One published run: the index and the inputs record the script stores beside it. */
  async function publish(built: Built[], publicKey: string) {
    const { download } = fakeDownload(built);
    const { ready } = await downloadReleases(
      built.map((one) => one.release),
      download,
    );
    const index = buildIndex({
      releases: ready,
      publicKey,
      repository: REPOSITORY,
      updatedAt: UPDATED_AT,
    });
    const inputs = inputsRecord({
      ready,
      publicKey,
      since: null,
      tooling: TOOLING,
      repository: REPOSITORY,
      index,
    });
    return { index, inputs };
  }

  async function published() {
    const keys = testKeyPair();
    const older = { engine: { termix: ">=26.0.0", api: "^2.7.0" } };
    const built = await Promise.all([
      fakeRelease("1.0.0", { keys }),
      fakeRelease("1.1.0-beta.1", { keys }),
      // A beta stable has passed: never listed, so it doesn't count as a change.
      fakeRelease("0.9.0-beta.1", {
        keys,
        manifest: manifestFor("0.9.0-beta.1", older),
      }),
      fakeRelease("0.8.0", { keys, omit: ["sig"] }),
    ]);
    const { index, inputs } = await publish(built, keys.publicKey);
    const releases = built.map((one) => one.release);
    const now = {
      releases,
      publicKey: keys.publicKey,
      since: null,
      tooling: TOOLING,
      repository: REPOSITORY,
      index,
    };
    return { keys, built, index, inputs, releases, now };
  }

  it("short-circuits while every input verification reads is byte for byte the same", async () => {
    const { inputs, now } = await published();
    expect(unchangedSince(inputs, now)).toBe(true);
    // The record survives the trip through inputs.json on the registry branch.
    expect(unchangedSince(JSON.parse(JSON.stringify(inputs)), now)).toBe(true);
  });

  it("is false after any change that needs a full read", async () => {
    const { keys, inputs, releases, now } = await published();
    const added = await fakeRelease("1.2.0", { keys });
    expect(
      unchangedSince(inputs, {
        ...now,
        releases: [...releases, added.release],
      }),
    ).toBe(false);
    expect(
      unchangedSince(inputs, { ...now, releases: releases.slice(1) }),
    ).toBe(false);
    expect(
      unchangedSince(inputs, { ...now, publicKey: testKeyPair().publicKey }),
    ).toBe(false);
    expect(unchangedSince(inputs, { ...now, tooling: "other-tooling" })).toBe(
      false,
    );
    expect(unchangedSince(null, now)).toBe(false);

    // The published index itself was changed by hand.
    const edited = structuredClone(now.index);
    edited.plugins[0].description = "Edited on the branch";
    expect(unchangedSince(inputs, { ...now, index: edited })).toBe(false);
    expect(unchangedSince(inputs, { ...now, index: null })).toBe(false);

    // Each of the three assets: replaced, or with no digest from the API.
    for (const at of [0, 1, 2]) {
      const replaced = structuredClone(releases);
      replaced[0].assets[at].digest = `sha256:${"1".repeat(64)}`;
      expect(
        unchangedSince(inputs, { ...now, releases: replaced }),
        `${at}`,
      ).toBe(false);
      const noDigest = structuredClone(releases);
      delete noDigest[0].assets[at].digest;
      expect(
        unchangedSince(inputs, { ...now, releases: noDigest }),
        `${at}`,
      ).toBe(false);
    }

    const drafted = structuredClone(releases);
    drafted[0].draft = true;
    expect(unchangedSince(inputs, { ...now, releases: drafted })).toBe(false);
  });

  it("is false when anything the index shows or verification reads changes", async () => {
    const { releases, inputs, now } = await published();
    const changed = (edit: (copy: typeof releases) => void) => {
      const copy = structuredClone(releases);
      edit(copy);
      return unchangedSince(inputs, { ...now, releases: copy });
    };
    // All three assets renamed together, bytes (and so digests) unchanged.
    expect(
      changed((copy) => {
        for (const asset of copy[0].assets) {
          asset.name = asset.name.replace("coolify-", "renamed-");
          asset.browser_download_url = asset.browser_download_url.replace(
            "coolify-",
            "renamed-",
          );
        }
      }),
    ).toBe(false);
    for (const at of [0, 1, 2]) {
      expect(
        changed((copy) => {
          copy[0].assets[at].browser_download_url += "?moved";
        }),
        `url ${at}`,
      ).toBe(false);
    }
    expect(
      changed(
        (copy) => (copy[0].assets[0].updated_at = "2026-11-21T00:00:00Z"),
      ),
    ).toBe(false);
    expect(changed((copy) => (copy[0].html_url += "-moved"))).toBe(false);
    expect(
      changed((copy) => (copy[0].published_at = "2026-11-21T00:00:00Z")),
    ).toBe(false);
    expect(changed((copy) => (copy[0].prerelease = !copy[0].prerelease))).toBe(
      false,
    );
    expect(
      unchangedSince(inputs, {
        ...now,
        repository: "https://github.com/someone/fork",
      }),
    ).toBe(false);
    // And nothing else: the same listing still short-circuits.
    expect(changed(() => undefined)).toBe(true);
  });

  it("checks a superseded beta on both paths, and counts each release once", async () => {
    const keys = testKeyPair();
    const stable = await fakeRelease("1.2.0", { keys });
    const { index, inputs } = await publish([stable], keys.publicKey);
    const now = {
      releases: [stable.release],
      repository: REPOSITORY,
      publicKey: keys.publicKey,
      since: null,
      tooling: TOOLING,
      index,
    };
    expect(unchangedSince(inputs, now)).toBe(true);

    // A beta older than stable is never listed, but it is still verified.
    const beta = await fakeRelease("1.1.0-beta.1", {
      keys: { ...testKeyPair(), publicKey: keys.publicKey },
    });
    expect(
      unchangedSince(inputs, {
        ...now,
        releases: [stable.release, beta.release],
      }),
    ).toBe(false);
    await expect(publish([stable, beta], keys.publicKey)).rejects.toThrow(
      /signature/,
    );

    // The same release listed twice is not the same listing.
    expect(
      unchangedSince(inputs, {
        ...now,
        releases: [stable.release, stable.release],
      }),
    ).toBe(false);
  });

  it("a replaced .sig is read again, and a bad one refuses the index", async () => {
    const keys = testKeyPair();
    const first = await fakeRelease("1.0.0", { keys });
    const { index, inputs } = await publish([first], keys.publicKey);

    // Same .tmxplug, a .sig from another key.
    const resigned = await fakeRelease("1.0.0", {
      keys,
      sig: sign(first.artifact, testKeyPair().privateKey),
    });
    expect(resigned.artifact.equals(first.artifact)).toBe(true);
    const now = {
      releases: [resigned.release],
      publicKey: keys.publicKey,
      since: null,
      tooling: TOOLING,
      repository: REPOSITORY,
      index,
    };
    expect(unchangedSince(inputs, now)).toBe(false);
    await expect(publish([resigned], keys.publicKey)).rejects.toThrow(
      /signature/,
    );
  });

  it("a replaced .sigstore.json is read again, and one for another file refuses the index", async () => {
    const keys = testKeyPair();
    const first = await fakeRelease("1.0.0", { keys });
    const { index, inputs } = await publish([first], keys.publicKey);

    const rebundled = await fakeRelease("1.0.0", {
      keys,
      provenance: provenanceFor("coolify-1.0.0.tmxplug", "0".repeat(64)),
    });
    expect(rebundled.artifact.equals(first.artifact)).toBe(true);
    const now = {
      releases: [rebundled.release],
      publicKey: keys.publicKey,
      since: null,
      tooling: TOOLING,
      repository: REPOSITORY,
      index,
    };
    expect(unchangedSince(inputs, now)).toBe(false);
    await expect(publish([rebundled], keys.publicKey)).rejects.toThrow(
      /provenance/,
    );
  });
});

describe("scripts/registry-index.mjs", () => {
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "registry-index.mjs"), ...args],
      {
        cwd: ROOT,
        encoding: "utf8",
        // No network: the key is checked before anything is fetched.
        env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
      },
    );

  it("refuses to write an index without a valid public key", () => {
    const keys = testKeyPair();
    withTemp((dir) => {
      const out = path.join(dir, "index.json");
      const missing = run([
        "--repo",
        "pacnpal/termix-coolify-plugin",
        "--key",
        path.join(dir, "none.txt"),
        "--out",
        out,
      ]);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toMatch(/public key/i);

      const keyFile = path.join(dir, "public-key.txt");
      fs.writeFileSync(keyFile, `${keys.privateKey}\n`);
      const invalid = run([
        "--repo",
        "pacnpal/termix-coolify-plugin",
        "--key",
        keyFile,
        "--out",
        out,
      ]);
      expect(invalid.status).not.toBe(0);
      expect(invalid.stderr).toMatch(/public key/i);
      expect(invalid.stdout + invalid.stderr).not.toContain(keys.privateKey);

      expect(fs.existsSync(out)).toBe(false);
    });
  });
});

describe("registry/", () => {
  const file = (name: string) => path.join(ROOT, "registry", name);

  it("public-key.txt is the owner's key, with the key id the README publishes", () => {
    const text = fs.readFileSync(file("public-key.txt"), "utf8");
    // One line: the key and a newline, nothing else (no private key, no comment).
    expect(text).toBe("Qhm4ZKAVAodNOzxb2Ez2DdcDccUAZUwKN9+id4JG7iU=\n");
    const { keyId } = parsePublicKey(text);
    expect(keyId).toBe("d07bfdc9da00b6e7");
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    expect(readme).toContain(`**Key id:** \`${keyId}\``);
  });

  it("nothing else in registry/ but the public key and first-version.txt", () => {
    const allowed = new Set(["public-key.txt", "first-version.txt"]);
    const extra = fs
      .readdirSync(path.join(ROOT, "registry"))
      .filter((name) => !allowed.has(name));
    expect(extra).toEqual([]);
  });

  it("first-version.txt is one version whenever it is committed", () => {
    if (!fs.existsSync(file("first-version.txt"))) return;
    expect(
      parseFirstVersion(fs.readFileSync(file("first-version.txt"), "utf8")),
    ).not.toBeNull();
  });
});
