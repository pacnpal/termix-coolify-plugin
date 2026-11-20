import { createHash } from "node:crypto";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { CoolifyApi, KeyForCopy } from "../coolify/api.js";
import { CoolifyError } from "../coolify/http.js";
import type { KeyDto } from "../coolify/dto.js";
import { trimTrailing } from "../text.js";

/** A Termix credential holding a copy of a Coolify key. */
export interface CopiedCredential {
  credentialId: number;
  fingerprint: string;
}

/**
 * A key copy's outcome: the credential, null when the key can't be read
 * (the server needs a picked credential), or why an earlier copy can't be
 * reused.
 */
export type CopyOutcome =
  CopiedCredential | { cause: "credential-check-failed" } | null;

/** What the plugin already knows about earlier copies, to reuse them. */
export interface KnownCopy {
  credentialId: number;
  fingerprint: string | null;
}

/** The credential name ADR 0002 sets: `Coolify: <connection> / <key>`. */
export function credentialName(connectionName: string, keyName: string) {
  return `Coolify: ${connectionName} / ${keyName}`;
}

/** OpenSSH's SHA256 fingerprint of a public key line, or null. */
export function publicKeyFingerprint(publicKey: string): string | null {
  const blob = publicKey.trim().split(/\s+/)[1];
  if (!blob || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null;
  const digest = createHash("sha256")
    .update(Buffer.from(blob, "base64"))
    .digest("base64");
  return `SHA256:${trimTrailing(digest, "=")}`;
}

/**
 * The public half when Coolify didn't send it. The SDK's helper needs ssh2,
 * which Termix supplies at run time; loaded only when needed.
 */
async function derivePublicKey(privateKey: string): Promise<string | null> {
  try {
    const keys = await import("@termix-ssh/plugin-sdk/ssh-keys");
    return keys.publicKeyFromPrivate(privateKey);
  } catch {
    return null;
  }
}

/**
 * Copies Coolify keys into Termix credentials for one sync, one credential per
 * key (ADR 0002). A credential is reused while the key's fingerprint stays the
 * same and replaced by a new one when it changes. Key material only passes
 * through memory here: it goes to ctx.credentials.createSshKey and nowhere
 * else. Every copy is audited, failed ones too.
 */
export function createKeyCopier(
  ctx: PluginContext,
  opts: {
    api: CoolifyApi;
    connectionId: number;
    connectionName: string;
    /** Copies this connection already made, by fingerprint. */
    known: KnownCopy[];
    /**
     * The ids of the actor's own SSH key credentials, or null when they can't
     * be read. A known copy is reused only while it is still one of them.
     */
    ownKeys: () => Promise<Set<number> | null>;
    /**
     * Runs right before a credential is created, after the key reads: it
     * throws to stop the copy when the sync must write nothing more.
     */
    beforeWrite: () => Promise<void>;
  },
) {
  let keyList: Promise<KeyDto[]> | null = null;
  const byKeyId = new Map<number, Promise<CopyOutcome>>();
  const copiedNow = new Set<number>();

  async function keyFor(keyId: number): Promise<KeyDto | null> {
    keyList ??= opts.api.keys();
    return (await keyList).find((k) => k.id === keyId) ?? null;
  }

  async function audit(
    name: string,
    success: boolean,
    details: Record<string, unknown>,
    credentialId?: number,
  ) {
    await ctx.audit.record({
      action: "coolify_key_copied",
      resourceType: "credential",
      resourceId: credentialId === undefined ? undefined : String(credentialId),
      resourceName: name,
      details: JSON.stringify({ connectionId: opts.connectionId, ...details }),
      success,
      errorMessage: success ? undefined : "The key could not be saved",
    });
  }

  async function material(uuid: string): Promise<KeyForCopy | null> {
    try {
      return await opts.api.keyForCopy(uuid);
    } catch (err) {
      // A token without read:sensitive: fall back to a picked credential.
      if (
        err instanceof CoolifyError &&
        (err.cause === "forbidden-ability" || err.cause === "not-found")
      ) {
        return null;
      }
      throw err;
    }
  }

  async function copy(keyId: number): Promise<CopyOutcome> {
    const meta = await keyFor(keyId);
    if (!meta?.uuid) return null;
    const key = await material(meta.uuid);
    if (!key?.privateKey) return null;
    const publicKey = key.publicKey ?? (await derivePublicKey(key.privateKey));
    if (!publicKey) return null;
    const fingerprint = key.fingerprint ?? publicKeyFingerprint(publicKey);
    if (!fingerprint) return null;

    // An earlier copy is reused only while the actor still has it: one they
    // deleted is copied again below. When their keys can't be read, nothing
    // is reused or copied (a copy could duplicate one that still exists).
    const earlier = opts.known.filter((k) => k.fingerprint === fingerprint);
    const fresh = earlier.find((k) => copiedNow.has(k.credentialId));
    if (fresh) return { credentialId: fresh.credentialId, fingerprint };
    if (earlier.length) {
      const owned = await opts.ownKeys();
      if (!owned) return { cause: "credential-check-failed" };
      const reuse = earlier.find((k) => owned.has(k.credentialId));
      if (reuse) return { credentialId: reuse.credentialId, fingerprint };
    }

    const name = credentialName(opts.connectionName, key.name || meta.name);
    const details = { keyUuid: meta.uuid, fingerprint };
    await opts.beforeWrite();
    let created: { id: number };
    try {
      created = await ctx.credentials.createSshKey({
        name,
        description: "Copied from Coolify by Coolify for Termix",
        privateKey: key.privateKey,
        publicKey,
        keyType: publicKey.trim().split(/\s+/)[0],
      });
    } catch (err) {
      await audit(name, false, details);
      throw err;
    }
    await audit(name, true, details, created.id);
    // Made in this sync, so later servers reuse it without another check.
    opts.known.push({ credentialId: created.id, fingerprint });
    copiedNow.add(created.id);
    return { credentialId: created.id, fingerprint };
  }

  return {
    /**
     * The credential for a server's Coolify key: reused, or copied now. Null
     * when the key can't be read, so the server needs a picked credential;
     * a cause when an earlier copy can't be checked.
     */
    credentialFor(keyId: number | null): Promise<CopyOutcome> {
      if (keyId === null) return Promise.resolve(null);
      let pending = byKeyId.get(keyId);
      if (!pending) {
        pending = copy(keyId);
        byKeyId.set(keyId, pending);
      }
      return pending;
    },
  };
}
