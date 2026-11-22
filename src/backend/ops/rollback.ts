import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import en from "../../../locales/en.json";
import { IMAGE_TAG } from "../coolify/dto.js";
import { ConnectionError } from "../connections/service.js";
import type {
  Deployments,
  RollbackImages,
  RollbackOutcome,
} from "../deployments/service.js";
import type { Sync } from "../sync/service.js";
import { connectionIdInput } from "./connections.js";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The image input, checked before anything is read. */
function imageInput(input: Record<string, unknown>): string {
  const image = text(input.image);
  if (!IMAGE_TAG.test(image)) {
    throw new ConnectionError("invalid-input", "image is not an image tag");
  }
  return image;
}

/** "Would roll back <name> to image <tag>", from locales. */
export function describeRollback(name: string, image: string): string {
  return en.ops.rollback.dryRun
    .replace("{{name}}", name)
    .replace("{{image}}", image);
}

function imagesResult(answer: RollbackImages) {
  const n = answer.images.length;
  return {
    summary: `${answer.name}: ${n} rollback image${n === 1 ? "" : "s"}${answer.current ? `, running ${answer.current}` : ""}`,
    // options fill the image picker of the rollback actions; the image
    // running now is not one to roll back to.
    data: {
      ...answer,
      options: answer.images
        .filter((i) => !i.current)
        .map((i) => ({
          value: i.tag,
          label: i.createdAt ? `${i.tag} (${i.createdAt})` : i.tag,
        })),
    },
  };
}

function rollbackResult(outcome: RollbackOutcome) {
  return {
    summary: outcome.deploymentUuid
      ? `Rollback of ${outcome.name} to ${outcome.image} queued (deployment ${outcome.deploymentUuid})`
      : `Rollback of ${outcome.name} to ${outcome.image} sent`,
    changed: true,
    data: outcome,
  };
}

/**
 * Rollback images and rollback, apps only, in both scopes. The resource
 * scope acts on a Linked host's application (its own server only); the
 * server scope takes a connection and a uuid. Every path goes through the
 * deployments service, which checks the connection and the actor's grant
 * after every await and right before Coolify is asked.
 */
export function registerRollbackOperations(
  ctx: PluginContext,
  deps: { deployments: Deployments; sync: Pick<Sync, "linkOfHost"> },
): void {
  const { deployments, sync } = deps;

  async function onHost(c: PluginOperationContext) {
    const link = c.hostId ? await sync.linkOfHost(c.hostId) : null;
    if (!link) {
      throw new ConnectionError(
        "not-linked",
        "This host is not linked to a Coolify server",
      );
    }
    return {
      connectionId: link.connectionId,
      uuid: c.resourceKey ?? "",
      serverUuid: link.serverUuid,
    };
  }

  ctx.operations.register("coolify.rollback-images", {
    run: async (_input, c) => {
      const t = await onHost(c);
      return imagesResult(
        await deployments.rollbackImages(t.connectionId, t.uuid, {
          serverUuid: t.serverUuid,
          signal: c.signal,
        }),
      );
    },
  });

  ctx.operations.register("coolify.resource-rollback-images", {
    run: async (input, c) =>
      imagesResult(
        await deployments.rollbackImages(
          connectionIdInput(input),
          text(input.uuid),
          { signal: c.signal },
        ),
      ),
  });

  ctx.operations.register("coolify.rollback", {
    run: async (input, c) => {
      const t = await onHost(c);
      return rollbackResult(
        await deployments.rollback(t.connectionId, t.uuid, text(input.image), {
          serverUuid: t.serverUuid,
          signal: c.signal,
        }),
      );
    },
    describe: async (input, c) => {
      const t = await onHost(c);
      const app = await deployments.rollbackTarget(t.connectionId, t.uuid, {
        serverUuid: t.serverUuid,
      });
      return describeRollback(app.name, imageInput(input));
    },
  });

  ctx.operations.register("coolify.resource-rollback", {
    run: async (input, c) =>
      rollbackResult(
        await deployments.rollback(
          connectionIdInput(input),
          text(input.uuid),
          text(input.image),
          { signal: c.signal },
        ),
      ),
    describe: async (input) => {
      const app = await deployments.rollbackTarget(
        connectionIdInput(input),
        text(input.uuid),
      );
      return describeRollback(app.name, imageInput(input));
    },
  });
}
