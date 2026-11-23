import { ConnectionError, type Connections } from "./service.js";

/**
 * Fails unless the connection still has `revision`: target-changed (409)
 * when it points elsewhere now, not-found when the actor can't reach it.
 * The one check behind `forRevision` and the resource and server lists.
 */
export async function stillAt(
  connections: Pick<Connections, "revision">,
  connectionId: number,
  revision: string,
): Promise<void> {
  const current = await connections.revision(connectionId);
  if (!current) {
    throw new ConnectionError("not-found", "Coolify connection not found");
  }
  if (current !== revision) {
    throw new ConnectionError(
      "target-changed",
      "The connection's address, token or Access settings changed. Try again.",
    );
  }
}

/**
 * Runs `read` and answers what it found only for the target it started on:
 * the connection's revision (address, token, Access and TLS settings) is
 * taken first and checked again once `read` is done, so rows fetched across
 * a repoint, or a mix of two targets, end with target-changed (409). A
 * connection the actor can't reach, before or after, is not-found.
 */
export async function forRevision<T>(
  connections: Pick<Connections, "revision">,
  connectionId: number,
  read: () => Promise<T>,
): Promise<T> {
  const revision = async () => {
    const current = await connections.revision(connectionId);
    if (!current) {
      throw new ConnectionError("not-found", "Coolify connection not found");
    }
    return current;
  };
  const before = await revision();
  const value = await read();
  await stillAt(connections, connectionId, before);
  return value;
}
