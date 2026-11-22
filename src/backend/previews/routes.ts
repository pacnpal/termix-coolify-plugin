import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { idParam, safe } from "../connections/routes.js";
import { ConnectionError } from "../connections/service.js";
import { failedOutcome, uuidParam } from "../resources/routes.js";
import {
  MAX_PULL_REQUEST_ID,
  readPreviewCreate,
  readPreviewDomains,
  type Previews,
} from "./service.js";

/** A pull request id from the path; anything else reads as missing. */
function pullRequestParam(req: Request): number {
  const raw = String(req.params.pullRequestId ?? "");
  const n = /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PULL_REQUEST_ID) {
    throw new ConnectionError("not-found", "Coolify preview not found");
  }
  return n;
}

function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body as unknown;
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** Only the named keys of a body, so an undeclared one never reaches a run. */
function pick(
  body: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (body[key] !== undefined) out[key] = body[key];
  return out;
}

function query(value: unknown): unknown {
  return typeof value === "string" ? value : undefined;
}

/**
 * An application's pull request previews: the list (view), its container
 * logs (operate: logs hold secrets), and open, change domains and delete
 * (operate, each through its action so the press lands in run history).
 */
export function registerPreviewRoutes(
  router: Router,
  ctx: PluginContext,
  previews: Previews,
): void {
  const view = ctx.rbac.require("view") as never;
  const operate = ctx.rbac.require("operate") as never;

  /**
   * Runs a preview action confirmed (the UI asked) and answers its data, or
   * the refusal or the waiting approval it came back with. The input is
   * checked and the caller authorized first, before the action and before
   * any Coolify request: through core, a refusal thrown inside an action can
   * come back as a plain error (a 502).
   */
  async function runAction(
    res: Response,
    target: {
      id: number;
      uuid: string;
      /** Input checks that need no Coolify request, run first. */
      check: () => void;
      /** Checks that read Coolify, run once the caller is authorized. */
      verify?: () => Promise<void>;
    },
    actionId: string,
    input: Record<string, unknown>,
    answer: (data: Record<string, unknown>) => unknown,
  ): Promise<void> {
    target.check();
    await previews.authorize(target.id, target.uuid);
    await target.verify?.();
    const outcome = await ctx.operations.run(actionId, {
      input,
      confirmed: true,
    });
    const failure = failedOutcome(outcome);
    if (failure) {
      res.status(failure.status).json(failure.body);
      return;
    }
    res.json(answer((outcome.data ?? {}) as Record<string, unknown>));
  }

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/previews:
   *   get:
   *     summary: An application's pull request previews
   *     description: >-
   *       Reads Coolify's preview list for the application. Needs
   *       coolify.view and any access to the connection; the uuid must be
   *       one of that connection's own applications (services and databases
   *       have no previews). Each row carries the newest build of its pull
   *       request from the application's latest 50 deployments, when there
   *       is one, so its build log can be opened.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: path
   *         name: uuid
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: >-
   *           { rows }, each { pullRequestId, uuid, pullRequestUrl, gitType,
   *           status, domains, composeDomains, dockerTag, lastOnlineAt,
   *           createdAt, updatedAt, deploymentUuid, deploymentStatus }
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: >-
   *           No such application on this connection, or another user's
   *           connection
   *       409:
   *         description: >-
   *           target-changed, or unsupported-by-instance when the connected
   *           Coolify (older than 4.7.5) has no preview API
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.get(
    "/connections/:id/resources/:uuid/previews",
    view,
    safe(ctx, async (req, res) => {
      res.json(await previews.list(idParam(req), uuidParam(req)));
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/previews:
   *   post:
   *     summary: Deploy a pull request preview of an application
   *     description: >-
   *       Opens the preview of a pull request, or redeploys it when it
   *       exists, and queues its deployment. Needs coolify.operate and the
   *       owner or an operate grant, and runs coolify.preview-create
   *       confirmed (the UI asks first). Inputs are checked before Coolify
   *       is asked; the connection and the caller's grant are checked again
   *       after every step and right before the request. Coolify needs a
   *       token with write and deploy to open a preview.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: path
   *         name: uuid
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - pullRequestId
   *             properties:
   *               pullRequestId:
   *                 type: integer
   *                 minimum: 1
   *                 maximum: 2147483647
   *               pullRequestUrl:
   *                 type: string
   *               gitType:
   *                 type: string
   *                 enum: [github, gitlab, gitea, bitbucket]
   *               commit:
   *                 type: string
   *               dockerTag:
   *                 type: string
   *               force:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: "{ pullRequestId, deploymentUuid }"
   *       202:
   *         description: Waiting for approval, with the run id
   *       400:
   *         description: A bad pull request id, URL, git type, commit or tag
   *       403:
   *         description: Missing coolify.operate, or a view grant
   *       404:
   *         description: No such application on this connection
   *       409:
   *         description: target-changed or unsupported-by-instance
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.post(
    "/connections/:id/resources/:uuid/previews",
    operate,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      const uuid = uuidParam(req);
      await runAction(
        res,
        {
          id,
          uuid,
          check: () => readPreviewCreate(bodyOf(req)),
          verify: () => previews.checkCreate(id, uuid, bodyOf(req)),
        },
        "coolify.preview-create",
        {
          connectionId: String(id),
          uuid,
          ...pick(bodyOf(req), [
            "pullRequestId",
            "pullRequestUrl",
            "gitType",
            "commit",
            "dockerTag",
            "force",
          ]),
        },
        (data) => ({
          pullRequestId: data.pullRequestId ?? null,
          deploymentUuid:
            typeof data.deploymentUuid === "string"
              ? data.deploymentUuid
              : null,
        }),
      );
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/previews/{pullRequestId}:
   *   patch:
   *     summary: Replace a pull request preview's domains
   *     description: >-
   *       Needs coolify.operate and the owner or an operate grant, and runs
   *       coolify.preview-domains confirmed (the UI asks first). Send
   *       domains (comma separated http or https URLs with a DNS host
   *       name, an optional port and path, no credentials, query or
   *       fragment, at most 20) for an ordinary application, or
   *       composeDomains ([{ name, domain }], domain checked the same way or
   *       empty) for a Docker Compose one. A bad list is refused before
   *       Coolify is asked.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: path
   *         name: uuid
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: pullRequestId
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               domains:
   *                 type: string
   *               composeDomains:
   *                 type: array
   *                 items:
   *                   type: object
   *                   properties:
   *                     name:
   *                       type: string
   *                     domain:
   *                       type: string
   *                       nullable: true
   *     responses:
   *       200:
   *         description: "{ pullRequestId, domains } or { pullRequestId, composeDomains }"
   *       202:
   *         description: Waiting for approval, with the run id
   *       400:
   *         description: A domain that fails the checks, with what is wrong
   *       403:
   *         description: Missing coolify.operate, or a view grant
   *       404:
   *         description: No such application or preview
   *       409:
   *         description: target-changed or unsupported-by-instance
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.patch(
    "/connections/:id/resources/:uuid/previews/:pullRequestId",
    operate,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      const uuid = uuidParam(req);
      const pullRequestId = pullRequestParam(req);
      await runAction(
        res,
        { id, uuid, check: () => readPreviewDomains(bodyOf(req)) },
        "coolify.preview-domains",
        {
          connectionId: String(id),
          uuid,
          pullRequestId,
          ...pick(bodyOf(req), ["domains", "composeDomains"]),
        },
        (data) => ({
          pullRequestId,
          ...("domains" in data ? { domains: data.domains } : {}),
          ...("composeDomains" in data
            ? { composeDomains: data.composeDomains }
            : {}),
        }),
      );
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/previews/{pullRequestId}:
   *   delete:
   *     summary: Delete a pull request preview
   *     description: >-
   *       Coolify cancels its deployments, stops its containers and removes
   *       its volumes and networks. Needs coolify.operate and the owner or
   *       an operate grant, and runs coolify.preview-delete (destructive)
   *       confirmed; the UI asks first. Coolify needs a token with write
   *       and deploy.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: path
   *         name: uuid
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: pullRequestId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: "{ pullRequestId }"
   *       202:
   *         description: Waiting for approval, with the run id
   *       403:
   *         description: Missing coolify.operate, or a view grant
   *       404:
   *         description: No such application or preview
   *       409:
   *         description: target-changed or unsupported-by-instance
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.delete(
    "/connections/:id/resources/:uuid/previews/:pullRequestId",
    operate,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      const uuid = uuidParam(req);
      const pullRequestId = pullRequestParam(req);
      await runAction(
        res,
        { id, uuid, check: () => undefined },
        "coolify.preview-delete",
        { connectionId: String(id), uuid, pullRequestId },
        () => ({ pullRequestId }),
      );
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/previews/{pullRequestId}/logs:
   *   get:
   *     summary: A pull request preview's container logs
   *     description: >-
   *       The preview's runtime logs through Coolify. Needs coolify.operate
   *       and the owner or an operate grant, and a token with
   *       read:sensitive. The text is redacted as one stream before it is
   *       answered: the connection's token and Access secret, private key
   *       blocks (across lines), URL passwords, credential query
   *       parameters, secret-named fields and Authorization credentials.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: path
   *         name: uuid
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: pullRequestId
   *         required: true
   *         schema:
   *           type: integer
   *       - in: query
   *         name: lines
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 10000
   *           default: 100
   *       - in: query
   *         name: timestamps
   *         schema:
   *           type: boolean
   *     responses:
   *       200:
   *         description: "{ pullRequestId, text }"
   *       400:
   *         description: A bad lines count
   *       403:
   *         description: >-
   *           Missing coolify.operate, a view grant, or a token without
   *           read:sensitive
   *       404:
   *         description: No such application or preview
   *       409:
   *         description: target-changed or unsupported-by-instance
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.get(
    "/connections/:id/resources/:uuid/previews/:pullRequestId/logs",
    operate,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      const uuid = uuidParam(req);
      const pullRequestId = pullRequestParam(req);
      res.json(
        await previews.logs(id, uuid, pullRequestId, {
          lines: query(req.query.lines),
          timestamps: query(req.query.timestamps),
        }),
      );
    }),
  );
}
