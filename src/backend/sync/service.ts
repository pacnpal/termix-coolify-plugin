import { and, eq, isNotNull } from "drizzle-orm";
import type {
  PluginContext,
  PluginHostUpdateInput,
} from "@termix-ssh/plugin-sdk/backend";
import { toServer, type ServerDto } from "../coolify/dto.js";
import { CoolifyError } from "../coolify/http.js";
import {
  ConnectionError,
  type ConnectionView,
  type Connections,
} from "../connections/service.js";
import { dbClient, type Tables } from "../db.js";
import { createKeyCopier, type KnownCopy } from "./credentials.js";
import { createLocks, type Locks } from "./locks.js";
import {
  cleanAddress,
  folderName,
  planHost,
  SSH_TERMINAL,
  type SshTerminalState,
} from "./mapping.js";

export type SyncMode = "coolify" | "termix";

/**
 * Stored as a row's credentialMode when copying its Coolify key failed: the
 * preview then asks for a picked credential. A pick, or a later copy that
 * works, replaces it.
 */
const COPY_FAILED = "copy-failed";

/** One Coolify server and the Termix host it is or would become. */
export interface SyncRow {
  server: ServerDto;
  hostId: number | null;
  status: "new" | "linked" | "gone" | "blocked";
  /**
   * needs-address, needs-credential, needs-ssh-terminal,
   * ssh-terminal-too-old, credential-not-found or credential-check-failed.
   */
  cause?: string;
  /** coolify: the key is copied from Coolify. termix: a picked credential. */
  mode: SyncMode;
  addressOverride: string | null;
  /** For needs-address: the connection URL's host name, to prefill. */
  suggestedAddress: string | null;
  /** The credential the host uses or will use, when known. */
  credentialId: number | null;
  tunnel: boolean;
}

/** One line of a confirmed sync. Servers left out are not touched. */
export interface SyncChoice {
  uuid: string;
  include: boolean;
  /** undefined keeps the stored override, null or "" clears it. */
  addressOverride?: string | null;
  /** A Termix credential to use instead of a copied key. */
  credentialId?: number | null;
}

export interface SyncResult {
  uuid: string;
  name: string;
  status: "created" | "updated" | "blocked" | "skipped" | "gone" | "failed";
  hostId: number | null;
  cause?: string;
}

interface ServerRow {
  id: number;
  connectionId: number;
  serverUuid: string;
  hostId: number | null;
  addressOverride: string | null;
  credentialMode: string | null;
  credentialId: number | null;
  keyFingerprint: string | null;
}

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

function invalid(message: string): ConnectionError {
  return new ConnectionError("invalid-input", message);
}

/** The body of a sync request, checked before anything is written. */
export function readChoices(value: unknown): SyncChoice[] {
  if (!Array.isArray(value)) throw invalid("choices must be a list");
  if (value.length > 500) throw invalid("too many choices");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw invalid("each choice must be an object");
    }
    const raw = entry as Record<string, unknown>;
    if (typeof raw.uuid !== "string" || !UUID.test(raw.uuid)) {
      throw invalid("each choice needs a server uuid");
    }
    if (raw.include !== undefined && typeof raw.include !== "boolean") {
      throw invalid("include must be true or false");
    }
    const choice: SyncChoice = {
      uuid: raw.uuid,
      include: raw.include !== false,
    };
    const address = cleanAddress(raw.addressOverride);
    if (address !== undefined) choice.addressOverride = address;
    if (raw.credentialId !== undefined && raw.credentialId !== null) {
      const id = raw.credentialId;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
        throw invalid("credentialId must be a credential id");
      }
      choice.credentialId = id;
    } else if (raw.credentialId === null) {
      choice.credentialId = null;
    }
    return choice;
  });
}

function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname || null;
  } catch {
    return null;
  }
}

function errorName(err: unknown): string {
  return (err as Error)?.name ?? "error";
}

/** The host settings that make a Linked host an ordinary one again. */
const RELEASED: PluginHostUpdateInput = {
  pluginEnable: { coolify: false },
  pluginSettings: {
    coolify: { coolifyConnectionId: "", coolifyServerUuid: "" },
  },
};

/**
 * Host sync: previews Coolify servers as Termix hosts, creates or updates
 * them as Linked hosts (locked while managed), and unlinks them. Host writes
 * run as the acting user, inside their own request or operation run.
 */
export async function createSync(
  ctx: PluginContext,
  deps: { tables: Tables; connections: Connections },
) {
  const t = deps.tables;
  const { connections } = deps;

  async function db() {
    return dbClient(ctx);
  }

  async function linkedIds(): Promise<number[]> {
    const rows = (await (
      await db()
    )
      .select()
      .from(t.servers)
      .where(isNotNull(t.servers.hostId))) as ServerRow[];
    return rows.map((r) => r.hostId!);
  }

  const locks: Locks = createLocks(ctx, await linkedIds());

  // Every change to a connection's Linked hosts and link rows (apply, unlink,
  // releaseConnection) runs one at a time per connection. Two syncs that both
  // read "no host yet" would otherwise both create and lock one, and the
  // second link row would fail the (connection, server) unique constraint.
  const queues = new Map<number, Promise<void>>();
  function serialized<T>(
    connectionId: number,
    work: () => Promise<T>,
  ): Promise<T> {
    const before = queues.get(connectionId) ?? Promise.resolve();
    const run = before.then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(connectionId, tail);
    void tail.then(() => {
      if (queues.get(connectionId) === tail) queues.delete(connectionId);
    });
    return run;
  }

  /**
   * A host this sync created whose link row could not be saved: nothing would
   * track it, so it is unlocked and deleted (or, if that fails, released).
   */
  async function discardHost(hostId: number): Promise<void> {
    locks.remove(hostId);
    try {
      if (await ctx.hosts.delete(hostId)) return;
    } catch (err) {
      ctx.log.warn(
        `coolify could not delete an unlinked host: ${errorName(err)}`,
      );
    }
    try {
      await ctx.hosts.update(hostId, RELEASED);
    } catch (err) {
      ctx.log.warn(
        `coolify could not release an unlinked host: ${errorName(err)}`,
      );
    }
  }

  async function rowsOf(connectionId: number): Promise<ServerRow[]> {
    return (await (
      await db()
    )
      .select()
      .from(t.servers)
      .where(eq(t.servers.connectionId, connectionId))) as ServerRow[];
  }

  async function saveRow(
    connectionId: number,
    uuid: string,
    existing: ServerRow | undefined,
    values: Partial<ServerRow> & { lastSyncedAt?: string },
  ): Promise<void> {
    const client = await db();
    if (existing) {
      await client
        .update(t.servers)
        .set(values)
        .where(eq(t.servers.id, existing.id));
    } else {
      await client
        .insert(t.servers)
        .values({ connectionId, serverUuid: uuid, ...values });
    }
    await ctx.db.persist();
  }

  async function connectionFor(id: number): Promise<ConnectionView> {
    const view = await connections.get(id);
    if (!view) {
      throw new ConnectionError("not-found", "Coolify connection not found");
    }
    return view;
  }

  function requireOwner(view: ConnectionView): ConnectionView {
    if (view.access !== "owner") {
      throw new ConnectionError(
        "forbidden",
        "Only the connection's owner can sync or unlink its hosts",
      );
    }
    return view;
  }

  async function ownedConnection(id: number): Promise<ConnectionView> {
    return requireOwner(await connectionFor(id));
  }

  /**
   * Fails closed unless the connection still exists, is the actor's, and
   * points at the target a sync took its snapshot of: a new address, token,
   * Access token or TLS setting ends the whole sync with target-changed.
   */
  async function assertSnapshotHolds(id: number, revision: string) {
    await ownedConnection(id);
    if ((await connections.revision(id)) !== revision) {
      throw new ConnectionError(
        "target-changed",
        "The connection's address, token or Access settings changed during the sync. Sync again.",
      );
    }
  }

  /** Copying keys is on unless the admin turned it off, and the token reads them. */
  async function copyAllowed(view: ConnectionView): Promise<boolean> {
    const setting = await ctx.settings.get<boolean>("allowKeyCopy");
    return setting !== false && view.abilities.keys;
  }

  /**
   * The plugins sync works with, from one ctx.plugins.list() call. Fails
   * closed: when the list can't be read, neither Docker nor SSH Terminal
   * counts as running, so tunnelled servers are blocked.
   */
  async function companions(): Promise<{
    docker: boolean;
    sshTerminal: SshTerminalState;
  }> {
    try {
      const plugins = await ctx.plugins.list();
      const active = (id: string) =>
        plugins.find((p) => p.id === id && p.state === "active");
      const terminal = active(SSH_TERMINAL.id);
      return {
        docker: Boolean(active("docker")),
        sshTerminal: {
          running: Boolean(terminal),
          version: terminal?.version ?? null,
        },
      };
    } catch {
      return {
        docker: false,
        sshTerminal: { running: false, version: null },
      };
    }
  }

  const NO_SSH_TERMINAL: SshTerminalState = { running: false, version: null };

  async function hostNames(): Promise<Map<number, string>> {
    try {
      const hosts = await ctx.hosts.listOwned();
      return new Map(hosts.map((h) => [h.id, h.name ?? h.ip]));
    } catch {
      return new Map();
    }
  }

  /**
   * Checks picked (termix-mode) credentials against the actor's own
   * credentials, with one ctx.credentials.list() call per preview or apply.
   * Fails closed: when the list can't be read, every picked credential is
   * refused. Copied Coolify keys are the plugin's own and aren't checked.
   */
  function ownCredentialCheck() {
    let ids: Promise<Set<number> | null> | null = null;
    return async (credentialId: number): Promise<string | null> => {
      ids ??= ctx.credentials.list().then(
        (list) => new Set(list.map((c) => c.id)),
        () => null,
      );
      const owned = await ids;
      if (!owned) return "credential-check-failed";
      return owned.has(credentialId) ? null : "credential-not-found";
    };
  }

  function modeOf(
    copy: boolean,
    server: ServerDto,
    row: ServerRow | undefined,
  ): SyncMode {
    if (row?.credentialMode === "termix" && row.credentialId) return "termix";
    if (row?.credentialMode === COPY_FAILED) return "termix";
    return copy && server.privateKeyId !== null ? "coolify" : "termix";
  }

  function previewRow(
    view: ConnectionView,
    copy: boolean,
    server: ServerDto,
    row: ServerRow | undefined,
    /** Why the stored picked credential can't be used, or null. */
    credentialCause: string | null,
    sshTerminal: SshTerminalState,
  ): SyncRow {
    const mode = modeOf(copy, server, row);
    const override = row?.addressOverride ?? null;
    const credentialId =
      mode === "termix"
        ? row?.credentialMode === "termix"
          ? row.credentialId
          : null
        : row?.credentialMode === "coolify"
          ? row.credentialId
          : null;
    const plan = planHost(server, {
      connectionId: view.id,
      connectionName: view.name,
      baseUrl: view.baseUrl,
      override,
      credentialId: credentialId ?? 0,
      folder: "",
      dockerRunning: false,
      sshTerminal,
      // A preview never reads the Access token: its rows don't carry it.
      cfAccess: null,
    });
    const hostId = row?.hostId ?? null;
    let cause: string | undefined;
    if (!plan.ok) cause = plan.cause;
    else if (mode === "termix" && !credentialId) cause = "needs-credential";
    else if (mode === "termix" && credentialCause) cause = credentialCause;
    return {
      server,
      hostId,
      status: cause ? "blocked" : hostId ? "linked" : "new",
      ...(cause ? { cause } : {}),
      mode,
      addressOverride: override,
      suggestedAddress: cause === "needs-address" ? hostOf(view.baseUrl) : null,
      credentialId: credentialId ?? null,
      tunnel: server.isTunnel,
    };
  }

  function goneRows(
    rows: ServerRow[],
    present: Set<string>,
    names: Map<number, string>,
  ): SyncRow[] {
    return rows
      .filter((r) => r.hostId !== null && !present.has(r.serverUuid))
      .map((r) => ({
        server: toServer({
          uuid: r.serverUuid,
          name: names.get(r.hostId!) ?? r.serverUuid,
        }),
        hostId: r.hostId,
        status: "gone" as const,
        mode: r.credentialMode === "termix" ? "termix" : "coolify",
        addressOverride: r.addressOverride,
        suggestedAddress: null,
        credentialId: r.credentialId,
        tunnel: false,
      }));
  }

  /** Turns a Linked host into an ordinary one, or deletes it. */
  async function release(
    row: ServerRow,
    removeHost: boolean,
  ): Promise<boolean> {
    const hostId = row.hostId!;
    let removed = false;
    if (removeHost) {
      removed = await ctx.hosts.delete(hostId);
    } else {
      await ctx.hosts.update(hostId, RELEASED);
    }
    locks.remove(hostId);
    const client = await db();
    await client
      .update(t.servers)
      .set({ hostId: null })
      .where(eq(t.servers.id, row.id));
    await ctx.db.persist();
    return removed;
  }

  // A deleted host only unlinks its row: the address override and the
  // credential choice stay for the next sync. It doesn't take the connection
  // lock: release() deletes hosts while holding it, and this only clears the
  // id of a host that no longer exists, which no sync step can undo.
  ctx.events.on("host.deleted", async (payload: unknown) => {
    const hostId = Number((payload as { hostId?: unknown } | null)?.hostId);
    if (!Number.isSafeInteger(hostId) || hostId <= 0) return;
    try {
      locks.remove(hostId);
      await (
        await db()
      )
        .update(t.servers)
        .set({ hostId: null })
        .where(eq(t.servers.hostId, hostId));
      await ctx.db.persist();
    } catch (err) {
      ctx.log.warn(`coolify host.deleted cleanup failed: ${errorName(err)}`);
    }
  });

  async function applyNow(
    connectionId: number,
    choices: SyncChoice[] | null,
  ): Promise<SyncResult[]> {
    // One snapshot of the target: the view (name, address, abilities and
    // revision), the Coolify client and the Access token all come from one
    // read of the connection, so a change made meanwhile can't mix in.
    const target = await connections.snapshot(connectionId);
    const view = requireOwner(target.view);
    const { api } = target;
    const servers = await api.servers();
    // The list came from the snapshot's target; a change while it was read
    // ends the sync before any key is copied or any row is saved.
    await assertSnapshotHolds(connectionId, view.revision);
    const rows = await rowsOf(connectionId);
    const byUuid = new Map(rows.map((r) => [r.serverUuid, r]));
    const wanted = choices && new Map(choices.map((c) => [c.uuid, c]));
    const copy = await copyAllowed(view);
    const known: KnownCopy[] = rows
      .filter((r) => r.credentialMode === "coolify" && r.credentialId)
      .map((r) => ({
        credentialId: r.credentialId!,
        fingerprint: r.keyFingerprint,
      }));
    // The actor's own SSH keys, read once, to check earlier copies still exist.
    let ownKeys: Promise<Set<number> | null> | null = null;
    const copier = createKeyCopier(ctx, {
      api,
      connectionId,
      connectionName: view.name,
      known,
      ownKeys: () =>
        (ownKeys ??= ctx.credentials.listSshKeys().then(
          (list) => new Set(list.map((k) => k.id)),
          () => null,
        )),
    });
    const folder = folderName(view.name, (await connections.list()).length);
    const { docker, sshTerminal } = await companions();
    // The snapshot's Access token is unsealed once, and only when a
    // tunnelled host is about to be written. It goes into that host's SSH
    // Terminal settings and nowhere else: never a result, a log or an audit
    // entry.
    const accessToken = target.cfAccess;
    let folderReady = false;
    const results: SyncResult[] = [];
    const checkCredential = ownCredentialCheck();

    for (const server of servers) {
      const choice: SyncChoice | undefined = wanted
        ? wanted.get(server.uuid)
        : { uuid: server.uuid, include: true };
      const row = byUuid.get(server.uuid);
      const base = { uuid: server.uuid, name: server.name };
      if (!choice?.include) {
        results.push({
          ...base,
          status: "skipped",
          hostId: row?.hostId ?? null,
        });
        continue;
      }
      const override =
        choice.addressOverride !== undefined
          ? choice.addressOverride
          : (row?.addressOverride ?? null);
      const picked =
        choice.credentialId !== undefined
          ? choice.credentialId
          : row?.credentialMode === "termix"
            ? row.credentialId
            : null;
      // A picked credential, new or stored, must be one of the actor's own
      // before anything is written for this server.
      const credentialCause = picked ? await checkCredential(picked) : null;
      if (credentialCause) {
        results.push({
          ...base,
          status: "blocked",
          cause: credentialCause,
          hostId: row?.hostId ?? null,
        });
        continue;
      }
      const remember: Partial<ServerRow> = { addressOverride: override };
      if (choice.credentialId !== undefined) {
        remember.credentialMode = picked ? "termix" : null;
        remember.credentialId = picked;
      }

      try {
        // Refusals that need no credential come first, so no key is copied
        // for a server that can't sync anyway.
        const precheck = planHost(server, {
          connectionId,
          connectionName: view.name,
          baseUrl: view.baseUrl,
          override,
          credentialId: 0,
          folder,
          dockerRunning: docker,
          sshTerminal,
          cfAccess: null,
        });
        if (!precheck.ok) {
          await saveRow(connectionId, server.uuid, row, remember);
          results.push({
            ...base,
            status: "blocked",
            cause: precheck.cause,
            hostId: row?.hostId ?? null,
          });
          continue;
        }

        let credentialId: number | null = picked ?? null;
        let mode: SyncMode = "termix";
        let fingerprint: string | null = null;
        let copyFailed = false;
        if (!credentialId && copy) {
          const copied = await copier.credentialFor(server.privateKeyId);
          if (copied && "cause" in copied) {
            await saveRow(connectionId, server.uuid, row, remember);
            results.push({
              ...base,
              status: "blocked",
              cause: copied.cause,
              hostId: row?.hostId ?? null,
            });
            continue;
          }
          if (copied && "credentialId" in copied) {
            credentialId = copied.credentialId;
            fingerprint = copied.fingerprint;
            mode = "coolify";
          } else {
            copyFailed = server.privateKeyId !== null;
          }
        }
        if (!credentialId) {
          // A failed copy is remembered, so the preview asks for a credential.
          const failed: Partial<ServerRow> = {
            credentialMode: COPY_FAILED,
            credentialId: null,
            keyFingerprint: null,
          };
          await saveRow(
            connectionId,
            server.uuid,
            row,
            copyFailed ? { ...remember, ...failed } : remember,
          );
          results.push({
            ...base,
            status: "blocked",
            cause: "needs-credential",
            hostId: row?.hostId ?? null,
          });
          continue;
        }

        const plan = planHost(server, {
          connectionId,
          connectionName: view.name,
          baseUrl: view.baseUrl,
          override,
          credentialId,
          folder,
          dockerRunning: docker,
          sshTerminal,
          cfAccess: server.isTunnel ? await accessToken() : null,
        });
        if (!plan.ok) throw new Error("plan changed");
        if (!folderReady) {
          // Fail closed before the first host write: the connection must
          // still exist, be the actor's and point at the snapshot's target.
          // Throws, ending the whole sync.
          await assertSnapshotHolds(connectionId, view.revision);
          await ctx.hosts.folders.ensure(folder, { icon: "Rocket" });
          folderReady = true;
        }

        let hostId: number | null = null;
        let status: SyncResult["status"] = "created";
        if (row?.hostId) {
          const updated = await ctx.hosts.update(row.hostId, plan.input);
          if (updated) {
            hostId = updated.id;
            status = "updated";
          } else {
            locks.remove(row.hostId);
          }
        }
        let created: number | null = null;
        if (hostId === null) {
          hostId = (await ctx.hosts.create(plan.input)).id;
          created = hostId;
        }
        locks.add(hostId);
        try {
          await saveRow(connectionId, server.uuid, row, {
            ...remember,
            hostId,
            credentialMode: mode,
            credentialId,
            keyFingerprint: mode === "coolify" ? fingerprint : null,
            lastSyncedAt: new Date().toISOString(),
          });
        } catch (err) {
          // Fail closed: a host no link row tracks must not stay locked.
          if (created !== null) await discardHost(created);
          throw err;
        }
        results.push({ ...base, status, hostId });
      } catch (err) {
        // A connection gone or no longer the actor's ends the sync.
        if (err instanceof ConnectionError) throw err;
        ctx.log.warn(`coolify sync of one server failed: ${errorName(err)}`);
        results.push({
          ...base,
          status: "failed",
          cause: err instanceof CoolifyError ? err.cause : "host-write-failed",
          hostId: row?.hostId ?? null,
        });
      }
    }

    const present = new Set(servers.map((s) => s.uuid));
    for (const row of rows) {
      if (row.hostId !== null && !present.has(row.serverUuid)) {
        results.push({
          uuid: row.serverUuid,
          name: row.serverUuid,
          status: "gone",
          hostId: row.hostId,
        });
      }
    }
    const count = (s: SyncResult["status"]) =>
      results.filter((r) => r.status === s).length;
    ctx.log.info(
      `coolify sync: ${count("created")} created, ${count("updated")} updated, ` +
        `${count("blocked")} blocked, ${count("failed")} failed`,
    );
    return results;
  }

  /** Makes a Linked host ordinary again, or deletes it with removeHost. */
  async function unlinkNow(
    connectionId: number,
    serverUuid: string,
    opts: { removeHost: boolean },
  ): Promise<{ hostId: number; removed: boolean }> {
    await ownedConnection(connectionId);
    const [row] = (await (
      await db()
    )
      .select()
      .from(t.servers)
      .where(
        and(
          eq(t.servers.connectionId, connectionId),
          eq(t.servers.serverUuid, serverUuid),
        ),
      )
      .limit(1)) as ServerRow[];
    if (!row?.hostId) {
      throw new ConnectionError(
        "not-linked",
        "This Coolify server has no Linked host",
      );
    }
    const hostId = row.hostId;
    const removed = await release(row, opts.removeHost);
    return { hostId, removed };
  }

  return {
    /** Refuses (403, or 404 for another user's) unless the actor owns it. */
    async assertOwner(connectionId: number): Promise<void> {
      await ownedConnection(connectionId);
    },

    /** Every Coolify server and the host it would become. Read only. */
    async preview(connectionId: number): Promise<SyncRow[]> {
      // The address, abilities and client come from one read, so the rows
      // describe one target. The Access token is never read here.
      const { view, api } = await connections.snapshot(connectionId);
      const servers = await api.servers();
      const rows = await rowsOf(connectionId);
      const byUuid = new Map(rows.map((r) => [r.serverUuid, r]));
      const copy = await copyAllowed(view);
      const present = new Set(servers.map((s) => s.uuid));
      const gone = rows.some(
        (r) => r.hostId !== null && !present.has(r.serverUuid),
      )
        ? goneRows(rows, present, await hostNames())
        : [];
      const check = ownCredentialCheck();
      const sshTerminal = servers.some((s) => s.isTunnel)
        ? (await companions()).sshTerminal
        : NO_SSH_TERMINAL;
      const previewed: SyncRow[] = [];
      for (const s of servers) {
        const row = byUuid.get(s.uuid);
        const picked =
          row?.credentialMode === "termix" ? row.credentialId : null;
        const credentialCause = picked ? await check(picked) : null;
        previewed.push(
          previewRow(view, copy, s, row, credentialCause, sshTerminal),
        );
      }
      return [...previewed, ...gone];
    },

    /**
     * Creates or updates a Linked host for each included server, then locks
     * it. A row that can't sync yet is reported and the others carry on.
     * Servers gone from Coolify are reported, never deleted. Null choices
     * include every server, with its stored address and credential. Runs
     * after any other change to this connection's hosts has finished.
     */
    async apply(
      connectionId: number,
      choices: SyncChoice[] | null,
    ): Promise<SyncResult[]> {
      return serialized(connectionId, () => applyNow(connectionId, choices));
    },

    /** Makes a Linked host ordinary again, or deletes it with removeHost. */
    async unlink(
      connectionId: number,
      serverUuid: string,
      opts: { removeHost: boolean },
    ): Promise<{ hostId: number; removed: boolean }> {
      return serialized(connectionId, () =>
        unlinkNow(connectionId, serverUuid, opts),
      );
    },

    /** The Linked host of a server, or null. */
    async linkedHostFor(
      connectionId: number,
      serverUuid: string,
    ): Promise<number | null> {
      const [row] = (await (
        await db()
      )
        .select()
        .from(t.servers)
        .where(
          and(
            eq(t.servers.connectionId, connectionId),
            eq(t.servers.serverUuid, serverUuid),
          ),
        )
        .limit(1)) as ServerRow[];
      return row?.hostId ?? null;
    },

    /**
     * The connection and Coolify server a Linked host belongs to, or null
     * for a host the plugin doesn't manage. It checks no access: callers
     * check the actor's access to the connection before using it.
     */
    async linkOfHost(
      hostId: number,
    ): Promise<{ connectionId: number; serverUuid: string } | null> {
      if (!Number.isSafeInteger(hostId) || hostId <= 0) return null;
      const [row] = (await (
        await db()
      )
        .select()
        .from(t.servers)
        .where(eq(t.servers.hostId, hostId))
        .limit(1)) as ServerRow[];
      return row
        ? { connectionId: row.connectionId, serverUuid: row.serverUuid }
        : null;
    },

    /**
     * Connections' releaseLinkedHosts hook: unlinks the connection's Linked
     * hosts, or deletes them with removeHosts, then runs `deleteRows` (the
     * connection's own removal). One host that can't be changed doesn't stop
     * the others.
     */
    async releaseConnection(
      connectionId: number,
      opts: { removeHosts: boolean },
      deleteRows: () => Promise<void>,
    ): Promise<void> {
      // Releasing and deleting run as one step of this connection's queue: a
      // sync queued before waits for it to finish, and one queued after starts
      // only once the connection is gone, so it finds nothing to sync.
      await serialized(connectionId, async () => {
        for (const row of await rowsOf(connectionId)) {
          if (row.hostId === null) continue;
          try {
            await release(row, opts.removeHosts);
          } catch (err) {
            locks.remove(row.hostId);
            ctx.log.warn(`coolify could not release a host: ${errorName(err)}`);
          }
        }
        await deleteRows();
      });
    },
  };
}

export type Sync = Awaited<ReturnType<typeof createSync>>;
