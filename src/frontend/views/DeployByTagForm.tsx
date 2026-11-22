import { useEffect, useRef, useState } from "react";
import { Tags } from "lucide-react";
import { useToast, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  NoticePanel,
  SwitchRow,
  TextField,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import { failureOf, type Api, type TagTargets } from "../api";
import { describeFailure } from "./ConnectionForm";

const PR = /^\d{1,10}$/;

/**
 * Deploy by tag: a tag, force, and a pull request with its Docker tag. Review
 * reads what the tag will hit and confirms with that list; only those
 * resources are sent, and the backend refuses if the tag hits others by then.
 * Keyed by connection and target where it is used, so a switch remounts it:
 * a confirm still open for the old one answers into an unmounted view, and
 * nothing is sent.
 */
export function DeployByTagForm({
  api,
  connectionId,
  revision,
  onDeployed,
  onClose,
}: {
  api: Api;
  connectionId: number;
  revision: string | null;
  /** After a deploy was sent, so the queue reads again. */
  onDeployed: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const toast = useToast();
  const target = `${connectionId}\n${revision}`;
  const current = useRef(target);
  current.current = target;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [tag, setTag] = useState("");
  const [force, setForce] = useState(false);
  const [pr, setPr] = useState("");
  const [dockerTag, setDockerTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Still the same view, on the same connection and target. */
  const still = (forTarget: string) =>
    mounted.current && current.current === forTarget;

  function describeTargets(found: TagTargets) {
    return (
      <div className="flex flex-col gap-2">
        <span>{t("deployByTag.confirm.description")}</span>
        <ul className="list-disc pl-5">
          {found.targets.map((r) => (
            <li key={r.uuid}>
              {t("deployByTag.confirm.target", {
                name: r.name,
                kind: t(`deployByTag.kinds.${r.kind}`),
                server: r.serverName ?? "-",
              })}
            </li>
          ))}
        </ul>
        {found.skippedServices > 0 && (
          <span>
            {t("deployByTag.skipped", { count: found.skippedServices })}
          </span>
        )}
        {force && <span>{t("deployByTag.confirm.force")}</span>}
      </div>
    );
  }

  async function review() {
    const name = tag.trim();
    const prText = pr.trim();
    const image = dockerTag.trim();
    if (!name) {
      setError(t("deployByTag.needsTag"));
      return;
    }
    if (prText && !PR.test(prText)) {
      setError(t("deployByTag.badPr"));
      return;
    }
    if (image && !prText) {
      setError(t("deployByTag.needsPr"));
      return;
    }
    const pullRequestId = prText ? Number(prText) : undefined;
    const forTarget = target;
    setError(null);
    setBusy(true);
    try {
      const found = await api.tagTargets(connectionId, {
        tag: name,
        pullRequestId,
      });
      if (!still(forTarget)) return;
      if (!found.targets.length) {
        setError(t("deployByTag.noTargets", { tag: name }));
        return;
      }
      const ok = await confirm({
        title: t("deployByTag.confirm.title", {
          tag: name,
          count: found.targets.length,
        }),
        description: describeTargets(found),
        confirmLabel: t("deployByTag.confirm.confirm"),
        destructive: false,
      });
      // The view moved to another connection or section while the confirm
      // was open: what was confirmed is no longer what is shown.
      if (!ok || !still(forTarget)) return;
      const answer = await api.deployByTag(connectionId, {
        tag: name,
        force,
        ...(pullRequestId === undefined ? {} : { pullRequestId }),
        ...(image ? { dockerTag: image } : {}),
        targets: found.targets.map((r) => r.uuid),
      });
      if (!still(forTarget)) return;
      toast.success(
        answer.pending
          ? t("deployByTag.pending")
          : t("deployByTag.deployed", { count: answer.queued }),
      );
      onDeployed();
    } catch (err) {
      if (still(forTarget)) {
        setError(
          failureOf(err) ? describeFailure(t, err) : t("deployByTag.failed"),
        );
      }
    } finally {
      if (still(forTarget)) setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-b border-border p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Tags className="size-4" />
        {t("deployByTag.title")}
      </div>
      <TextField
        label={t("deployByTag.tag")}
        value={tag}
        onChange={setTag}
        placeholder={t("deployByTag.tagPlaceholder")}
        hint={t("deployByTag.tagHint")}
        mono
      />
      <SwitchRow
        label={t("deployByTag.force")}
        description={t("deployByTag.forceHint")}
        checked={force}
        onChange={setForce}
      />
      <TextField
        label={t("deployByTag.pullRequest")}
        value={pr}
        onChange={setPr}
        placeholder={t("deployByTag.pullRequestPlaceholder")}
        hint={t("deployByTag.pullRequestHint")}
      />
      <TextField
        label={t("deployByTag.dockerTag")}
        value={dockerTag}
        onChange={setDockerTag}
        placeholder={t("deployByTag.dockerTagPlaceholder")}
        hint={t("deployByTag.dockerTagHint")}
        mono
      />
      {error && <NoticePanel tone="destructive" title={error} />}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void review()}>
          {t("deployByTag.review")}
        </Button>
        <Button size="sm" variant="outline" onClick={onClose}>
          {t("deployByTag.close")}
        </Button>
      </div>
    </div>
  );
}
