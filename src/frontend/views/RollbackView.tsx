import { useEffect, useMemo, useRef, useState } from "react";
import { History, TriangleAlert, Undo2 } from "lucide-react";
import {
  usePluginApi,
  useToast,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  ListBadge,
  ListRow,
  LoadingState,
  NoticePanel,
  PanelList,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  failureOf,
  type Resource,
  type RollbackImage,
  type RollbackImages,
} from "../api";
import { describeFailure } from "./ConnectionForm";
import { formatTime } from "./resource-model";

type Read =
  | { kind: "loading" }
  | { kind: "ok"; list: RollbackImages }
  | { kind: "failed" };

/**
 * An application's rollback images, and Roll back to one of them after a
 * confirm that names its tag. Applications only: for anything else it reads
 * and offers nothing. Every answer is kept with the application it is for,
 * so another one never shows it, and a confirm answered after the view moved
 * to another application, or went away, sends nothing.
 */
export function RollbackView({
  connectionId,
  resource,
  onDone,
}: {
  connectionId: number;
  resource: Resource;
  /** After a rollback was sent, so the history around it can read again. */
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const confirm = useConfirm();
  const toast = useToast();
  const isApp = resource.kind === "application";
  const key = `${connectionId}\n${resource.uuid}`;
  const current = useRef(key);
  current.current = key;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [state, setState] = useState<{ key: string; read: Read }>({
    key,
    read: { kind: "loading" },
  });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const read: Read = state.key === key ? state.read : { kind: "loading" };

  useEffect(() => {
    if (!isApp) return;
    let live = true;
    api
      .listRollbackImages(connectionId, resource.uuid)
      .then((list) => {
        if (live) setState({ key, read: { kind: "ok", list } });
      })
      .catch(() => {
        if (live) setState({ key, read: { kind: "failed" } });
      });
    return () => {
      live = false;
    };
  }, [api, connectionId, resource.uuid, key, isApp, attempt]);

  async function rollBack(image: RollbackImage): Promise<void> {
    const forKey = key;
    const uuid = resource.uuid;
    const vars = { name: resource.name, tag: image.tag };
    const ok = await confirm({
      title: t("deployments.rollbackConfirm.title", vars),
      description: t("deployments.rollbackConfirm.description", vars),
      confirmLabel: t("deployments.rollbackConfirm.confirm", vars),
      destructive: true,
    });
    // The view moved to another application, or went away, while the
    // confirm was open: what was confirmed is not what is shown.
    if (!ok || !mounted.current || current.current !== forKey) return;
    setBusy(image.tag);
    try {
      const answer = await api.rollback(connectionId, uuid, image.tag);
      toast.success(
        answer.pending
          ? t("deployments.rollbackPending")
          : t("deployments.rolledBack", { tag: image.tag }),
      );
      if (mounted.current && current.current === forKey) onDone?.();
    } catch (err) {
      toast.error(
        failureOf(err)
          ? describeFailure(t, err)
          : t("deployments.rollbackFailed"),
      );
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  if (!isApp) return null;

  let body;
  if (read.kind === "loading") {
    body = <LoadingState label={t("deployments.rollbackImages.loading")} />;
  } else if (read.kind === "failed") {
    body = (
      <div className="p-4">
        <NoticePanel
          icon={TriangleAlert}
          title={t("deployments.rollbackImages.failed")}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAttempt((n) => n + 1)}
            >
              {t("deployments.rollbackImages.retry")}
            </Button>
          }
        />
      </div>
    );
  } else if (!read.list.images.some((i) => !i.current)) {
    body = (
      <EmptyState
        icon={History}
        title={t("deployments.rollbackImages.empty")}
      />
    );
  } else {
    body = (
      <PanelList>
        {read.list.images.map((image, i) => (
          <ListRow
            key={image.tag}
            stripe={i}
            title={<span className="font-mono">{image.tag}</span>}
            meta={[
              image.createdAt ? formatTime(image.createdAt) : null,
              image.source
                ? t(`deployments.rollbackImages.${image.source}`)
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            badges={
              image.current ? (
                <ListBadge tone="success">
                  {t("deployments.rollbackImages.current")}
                </ListBadge>
              ) : undefined
            }
            trailing={
              image.current ? undefined : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  aria-label={t("deployments.rollbackImages.action", {
                    tag: image.tag,
                  })}
                  onClick={() => void rollBack(image)}
                >
                  <Undo2 className="size-3.5" />
                  {t("deployments.rollbackOpen")}
                </Button>
              )
            }
          />
        ))}
      </PanelList>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-2 text-sm font-medium">
        {t("deployments.rollbackImages.title")}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  );
}
