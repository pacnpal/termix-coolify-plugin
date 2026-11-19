import type {
  PluginContext,
  PluginSshExecResult,
} from "@termix-ssh/plugin-sdk/backend";

/** Runs one command on a Linked host as the acting user. */
export type SshRunner = (
  hostId: number,
  command: string,
  opts?: { stdin?: string; timeoutMs?: number },
) => Promise<PluginSshExecResult>;

/** Short probes on a Linked host, through core's SSH pipeline (ctx.ssh.exec). */
export function sshRunner(ctx: PluginContext): SshRunner {
  return (hostId, command, opts = {}) =>
    ctx.ssh.exec(hostId, command, {
      purpose: "coolify",
      profile: "background",
      timeoutMs: opts.timeoutMs ?? 20_000,
      maxOutputBytes: 256 * 1024,
      stdin: opts.stdin,
    });
}

/**
 * Whether docker needs sudo on a Linked host: the SSH user is not root and
 * not in the docker group. Null when the user can't be read.
 */
export async function dockerNeedsSudo(
  run: SshRunner,
  hostId: number,
): Promise<boolean | null> {
  const result = await run(hostId, "id -u; id -Gn");
  const [uid, groups] = result.stdout.split("\n").map((l) => l.trim());
  if (result.code !== 0 || !/^\d+$/.test(uid ?? "")) return null;
  if (uid === "0") return false;
  return !(groups ?? "").split(/\s+/).includes("docker");
}

const HOST_KEY_CODES = new Set(["HOST_KEY_UNVERIFIED", "HOST_KEY_CHANGED"]);

/**
 * Whether an SSH failure is core refusing a host key that was never trusted
 * (or changed). A connection with no terminal can't ask, so the person has to
 * open a terminal to the host once.
 */
export function isHostKeyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && HOST_KEY_CODES.has(code)) return true;
  const message = (err as { message?: unknown } | null)?.message;
  return (
    typeof message === "string" &&
    [...HOST_KEY_CODES].some((c) => message.includes(c))
  );
}
