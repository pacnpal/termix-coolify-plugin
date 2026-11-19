import { useMemo, useState } from "react";
import { Hammer, Play, Rocket, RotateCw, Square } from "lucide-react";
import {
  usePluginApi,
  useToast,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import { Button, ListRowAction, useConfirm } from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  failureOf,
  type LifecycleVerb,
  type Resource,
} from "../api";
import { resourceHealth } from "../../shared/resource-health";
import { describeFailure } from "./ConnectionForm";

const isPart = (r: Resource) =>
  r.kind === "service-application" || r.kind === "service-database";

/**
 * Start is offered for a stopped resource (exited included, whatever its
 * health suffix, as resource-health reads it), Stop otherwise.
 */
function canStart(r: Resource): boolean {
  return resourceHealth(r.status) === "stopped";
}

/**
 * Runs lifecycle actions for one connection: confirms where asked, posts to
 * the lifecycle route, reports with a toast and tells the caller to reload.
 */
export function useLifecycle(connectionId: number, onChanged: () => void) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function run(
    resource: Resource,
    verb: LifecycleVerb,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const name = resource.name;
    if (verb === "stop") {
      const ok = await confirm({
        title: t("lifecycle.stopConfirm.title", { name }),
        description: t("lifecycle.stopConfirm.description"),
        confirmLabel: t("lifecycle.stopConfirm.confirm"),
        destructive: true,
      });
      if (!ok) return;
    }
    if (verb === "deploy" && opts.force) {
      const ok = await confirm({
        title: t("lifecycle.forceConfirm.title", { name }),
        description: t("lifecycle.forceConfirm.description"),
        confirmLabel: t("lifecycle.forceConfirm.confirm"),
        destructive: false,
      });
      if (!ok) return;
    }
    setBusy(resource.uuid);
    try {
      const answer = await api.resourceAction(
        connectionId,
        resource.uuid,
        verb,
        opts,
      );
      toast.success(
        answer.status === "pending"
          ? t("lifecycle.done.pending", { name })
          : t(`lifecycle.done.${verb}`, { name }),
      );
      onChanged();
    } catch (err) {
      toast.error(
        failureOf(err)
          ? describeFailure(t, err)
          : t("lifecycle.failed", { name }),
      );
    } finally {
      setBusy(null);
    }
  }

  return { run, busy };
}

export type LifecycleRunner = ReturnType<typeof useLifecycle>;

/**
 * The detail header's buttons: Deploy and Force rebuild (not for a Part,
 * which deploys with its service), Restart, and Start or Stop.
 */
export function ResourceActions({
  resource,
  lifecycle,
}: {
  resource: Resource;
  lifecycle: LifecycleRunner;
}) {
  const { t } = useTranslation();
  const disabled = lifecycle.busy !== null;
  const run = (verb: LifecycleVerb, opts?: { force?: boolean }) =>
    void lifecycle.run(resource, verb, opts);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!isPart(resource) && (
        <>
          <Button size="sm" disabled={disabled} onClick={() => run("deploy")}>
            <Rocket className="size-3.5" />
            {t("lifecycle.deploy")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => run("deploy", { force: true })}
          >
            <Hammer className="size-3.5" />
            {t("lifecycle.forceRebuild")}
          </Button>
        </>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => run("restart")}
      >
        <RotateCw className="size-3.5" />
        {t("lifecycle.restart")}
      </Button>
      {canStart(resource) ? (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => run("start")}
        >
          <Play className="size-3.5" />
          {t("lifecycle.start")}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => run("stop")}
        >
          <Square className="size-3.5" />
          {t("lifecycle.stop")}
        </Button>
      )}
    </div>
  );
}

/** A Part row's own Restart, in its service's Parts list. */
export function PartRestart({
  part,
  lifecycle,
}: {
  part: Resource;
  lifecycle: LifecycleRunner;
}) {
  const { t } = useTranslation();
  return (
    <ListRowAction
      label={t("lifecycle.restartPart", { name: part.name })}
      aria-label={t("lifecycle.restartPart", { name: part.name })}
      disabled={lifecycle.busy !== null}
      onClick={(event) => {
        event.stopPropagation();
        void lifecycle.run(part, "restart");
      }}
    >
      <RotateCw className="size-3.5" />
    </ListRowAction>
  );
}
