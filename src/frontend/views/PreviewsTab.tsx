import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  GitPullRequest,
  Globe,
  Rocket,
  ScrollText,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  usePluginApi,
  useToast,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  BackButton,
  Button,
  EmptyState,
  Field,
  Input,
  ListRow,
  LoadingState,
  NoticePanel,
  PanelList,
  RefreshButton,
  SelectField,
  StatusBadge,
  ToolbarBand,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  failureOf,
  type Preview,
  type PreviewDomainsChange,
  type Resource,
} from "../api";
import { checkDomains } from "../../shared/domains";
import { COMMIT_SHA, IMAGE_TAG } from "../../shared/image-tag";
import { resourceHealth } from "../../shared/resource-health";
import { BuildLogView, DeploymentStatus } from "./BuildLogView";
import { describeFailure } from "./ConnectionForm";
import { HEALTH_TONE, healthLabel } from "./resource-model";

type T = (key: string, options?: Record<string, unknown>) => string;

const MAX_PULL_REQUEST_ID = 2_147_483_647;
/** "auto" leaves it to the application's source (a select item can't be ""). */
const GIT_TYPES = ["auto", "github", "gitlab", "gitea", "bitbucket"] as const;
type GitChoice = (typeof GIT_TYPES)[number];

type Load =
  | { kind: "loading" }
  | { kind: "ok"; rows: Preview[] }
  | { kind: "failed"; unsupported: boolean };

type View =
  | { kind: "list" }
  | { kind: "build"; pullRequestId: number; deploymentUuid: string }
  | { kind: "logs"; pullRequestId: number };

/** Everything the forms hold, for one target only. */
interface Forms {
  target: string;
  creating: boolean;
  pullRequestId: string;
  pullRequestUrl: string;
  gitType: GitChoice;
  commit: string;
  dockerTag: string;
  createError: string | null;
  /** The preview whose domains are being edited. */
  editing: number | null;
  domains: string;
  /** A Docker Compose preview's domains, one entry per service. */
  composeDomains: { name: string; domain: string }[] | null;
  domainsError: string | null;
  /** The Compose service the error is about. */
  domainsErrorFor: string | null;
}

function noForms(target: string): Forms {
  return {
    target,
    creating: false,
    pullRequestId: "",
    pullRequestUrl: "",
    gitType: "auto",
    commit: "",
    dockerTag: "",
    createError: null,
    editing: null,
    domains: "",
    composeDomains: null,
    domainsError: null,
    domainsErrorFor: null,
  };
}

/** What a closed domain editor holds. */
const NO_EDIT = {
  editing: null,
  domains: "",
  composeDomains: null,
  domainsError: null,
  domainsErrorFor: null,
} as const;

/**
 * Whether a preview's domains are per Docker Compose service: Coolify's
 * domains field doesn't apply to them, only docker_compose_domains does.
 */
function isCompose(resource: Resource, preview: Preview): boolean {
  return (
    resource.buildPack === "dockercompose" || preview.composeDomains.length > 0
  );
}

/** A pull request number typed in, or null when it isn't one. */
function pullRequestOf(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,10}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 && n <= MAX_PULL_REQUEST_ID ? n : null;
}

/** A labelled text input, its label tied to the control. */
function TextInput({
  label,
  value,
  onChange,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <Input
        id={id}
        className="font-mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/** One preview's container logs, read once per open (and on refresh). */
function PreviewLogs({
  connectionId,
  resourceUuid,
  pullRequestId,
}: {
  connectionId: number;
  resourceUuid: string;
  pullRequestId: number;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const key = `${connectionId}\n${resourceUuid}\n${pullRequestId}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string;
    text: string | null;
    failed: boolean;
  }>({ key, text: null, failed: false });
  const shown = state.key === key ? state : { key, text: null, failed: false };

  useEffect(() => {
    let live = true;
    setState({ key, text: null, failed: false });
    api
      .previewLogs(connectionId, resourceUuid, pullRequestId)
      .then((text) => live && setState({ key, text, failed: false }))
      .catch(() => live && setState({ key, text: null, failed: true }));
    return () => {
      live = false;
    };
  }, [api, connectionId, resourceUuid, pullRequestId, key, attempt]);

  let body;
  if (shown.failed) {
    body = (
      <div className="p-4">
        <NoticePanel icon={TriangleAlert} title={t("previews.logs.failed")} />
      </div>
    );
  } else if (shown.text === null) {
    body = <LoadingState label={t("previews.logs.loading")} />;
  } else if (shown.text === "") {
    body = <EmptyState icon={ScrollText} title={t("previews.logs.empty")} />;
  } else {
    body = (
      <pre
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-muted/30 px-3 py-2 font-mono text-xs leading-5"
        role="log"
        aria-label={t("previews.logs.title")}
      >
        {shown.text}
      </pre>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ToolbarBand>
        <RefreshButton
          label={t("previews.logs.refresh")}
          loading={shown.text === null && !shown.failed}
          onClick={() => setAttempt((n) => n + 1)}
        />
      </ToolbarBand>
      {body}
    </div>
  );
}

/**
 * An application's pull request previews: the list with each one's status,
 * domains and newest build; deploying a preview for a pull request, changing
 * a preview's domains and deleting one (operate, each after a confirm); a
 * preview's build log (BuildLogView) and container logs. Everything shown is
 * kept with the connection and application it is for, so a render for
 * another one never shows it, and an answer that lands after the view moved
 * on is dropped. A confirm answered after the view moved on, or unmounted,
 * sends nothing.
 */
export function PreviewsTab({
  connectionId,
  resource,
  canOperate,
  isVisible = true,
}: {
  connectionId: number;
  resource: Resource;
  /** coolify.operate and an operate grant: changes, build logs and logs. */
  canOperate: boolean;
  /** Whether the tab is shown; an open build log stops polling while it isn't. */
  isVisible?: boolean;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const confirm = useConfirm();
  const toast = useToast();
  const target = `${connectionId}\n${resource.uuid}`;
  const current = useRef(target);
  current.current = target;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ target: string; load: Load }>({
    target,
    load: { kind: "loading" },
  });
  const load: Load = state.target === target ? state.load : { kind: "loading" };
  const [viewState, setViewState] = useState<{ target: string; view: View }>({
    target,
    view: { kind: "list" },
  });
  const view: View =
    viewState.target === target ? viewState.view : { kind: "list" };
  const [formState, setFormState] = useState<Forms>(() => noForms(target));
  const forms = formState.target === target ? formState : noForms(target);
  const [busy, setBusy] = useState(false);
  /** A Docker image application: a new preview needs its image tag. */
  const dockerImage = resource.buildPack === "dockerimage";

  /**
   * Whether this view can edit a preview's domains. A Docker Compose
   * preview's are per service, and only the services Coolify lists can be
   * named; with none listed there is nothing sound to send.
   */
  function editable(preview: Preview): boolean {
    return !isCompose(resource, preview) || preview.composeDomains.length > 0;
  }

  function setForms(patch: Partial<Forms>, forTarget = target) {
    setFormState((prev) => ({
      ...(prev.target === forTarget ? prev : noForms(forTarget)),
      ...patch,
      target: forTarget,
    }));
  }

  function show(next: View, forTarget = target) {
    setViewState({ target: forTarget, view: next });
  }

  useEffect(() => {
    if (view.kind !== "list") return;
    let live = true;
    setState((prev) =>
      prev.target === target && prev.load.kind === "loading"
        ? prev
        : { target, load: { kind: "loading" } },
    );
    api
      .listPreviews(connectionId, resource.uuid)
      .then((rows) => {
        if (live) setState({ target, load: { kind: "ok", rows } });
      })
      .catch((err) => {
        if (!live) return;
        setState({
          target,
          load: {
            kind: "failed",
            unsupported: failureOf(err)?.cause === "unsupported-by-instance",
          },
        });
      });
    return () => {
      live = false;
    };
  }, [api, connectionId, resource.uuid, target, attempt, view.kind]);

  /** The view still shows `forTarget` and is mounted: act, or drop it. */
  function still(forTarget: string): boolean {
    return mounted.current && current.current === forTarget;
  }

  function failed(err: unknown, fallback: string): string {
    return failureOf(err) ? describeFailure(t, err) : fallback;
  }

  async function create(): Promise<void> {
    const forTarget = target;
    const id = pullRequestOf(forms.pullRequestId);
    if (id === null) {
      setForms({ createError: t("previews.create.invalidId") });
      return;
    }
    const url = forms.pullRequestUrl.trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) {
      setForms({ createError: t("previews.create.invalidUrl") });
      return;
    }
    // Shown only where they apply; a hidden one is never sent.
    const commit = forms.gitType === "bitbucket" ? forms.commit.trim() : "";
    if (commit && !COMMIT_SHA.test(commit)) {
      setForms({ createError: t("previews.create.invalidCommit") });
      return;
    }
    const dockerTag = dockerImage ? forms.dockerTag.trim() : "";
    if (dockerTag && !IMAGE_TAG.test(dockerTag)) {
      setForms({ createError: t("previews.create.invalidDockerTag") });
      return;
    }
    setForms({ createError: null });
    const ok = await confirm({
      title: t("previews.create.confirm.title", { id }),
      description: t("previews.create.confirm.description"),
      confirmLabel: t("previews.create.confirm.confirm"),
    });
    // The view moved to another application, or closed, while the confirm
    // was open: what was confirmed is no longer what is shown.
    if (!ok || !still(forTarget)) return;
    setBusy(true);
    try {
      const answer = await api.createPreview(connectionId, resource.uuid, {
        pullRequestId: id,
        ...(url ? { pullRequestUrl: url } : {}),
        ...(forms.gitType === "auto" ? {} : { gitType: forms.gitType }),
        ...(commit ? { commit } : {}),
        ...(dockerTag ? { dockerTag } : {}),
      });
      if (!still(forTarget)) return;
      toast.success(
        answer.pending
          ? t("previews.create.pending")
          : t("previews.create.done", { id }),
      );
      setForms(noForms(forTarget), forTarget);
      if (answer.deploymentUuid) {
        show(
          {
            kind: "build",
            pullRequestId: id,
            deploymentUuid: answer.deploymentUuid,
          },
          forTarget,
        );
      } else {
        setAttempt((n) => n + 1);
      }
    } catch (err) {
      if (still(forTarget)) {
        toast.error(failed(err, t("previews.create.failed")));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  /**
   * The domains change the editor holds, every list checked as the backend
   * checks it, or the first problem and the Compose service it is about.
   */
  function domainsChange():
    | { change: PreviewDomainsChange; shown: string }
    | { error: string; service: string | null } {
    const problem = (text: string) => {
      const checked = checkDomains(text);
      return "reason" in checked
        ? { error: t(`previews.domains.errors.${checked.reason}`) }
        : { value: checked.value };
    };
    if (forms.composeDomains) {
      const composeDomains: { name: string; domain: string | null }[] = [];
      for (const service of forms.composeDomains) {
        const text = service.domain.trim();
        const checked = text ? problem(text) : { value: null };
        if ("error" in checked) {
          return { error: checked.error, service: service.name };
        }
        composeDomains.push({ name: service.name, domain: checked.value });
      }
      return {
        change: { composeDomains },
        shown: composeDomains
          .map((d) => `${d.name}: ${d.domain ?? "-"}`)
          .join("; "),
      };
    }
    const checked = problem(forms.domains);
    if ("error" in checked) return { error: checked.error, service: null };
    return {
      change: { domains: checked.value },
      shown: checked.value.split(",").join(", "),
    };
  }

  function editDomains(preview: Preview): void {
    setForms({
      ...NO_EDIT,
      editing: preview.pullRequestId,
      domains: preview.domains.join(","),
      composeDomains: isCompose(resource, preview)
        ? preview.composeDomains.map((d) => ({
            name: d.name,
            domain: d.domain ?? "",
          }))
        : null,
    });
  }

  async function saveDomains(preview: Preview): Promise<void> {
    const forTarget = target;
    const id = preview.pullRequestId;
    const checked = domainsChange();
    if ("error" in checked) {
      setForms({
        domainsError: checked.error,
        domainsErrorFor: checked.service,
      });
      return;
    }
    setForms({ domainsError: null, domainsErrorFor: null });
    const ok = await confirm({
      title: t("previews.domains.confirm.title", { id }),
      description: t("previews.domains.confirm.description", {
        domains: checked.shown,
      }),
      confirmLabel: t("previews.domains.confirm.confirm"),
    });
    if (!ok || !still(forTarget)) return;
    setBusy(true);
    try {
      const answer = await api.setPreviewDomains(
        connectionId,
        resource.uuid,
        id,
        checked.change,
      );
      if (!still(forTarget)) return;
      toast.success(
        answer.pending
          ? t("previews.domains.pending")
          : t("previews.domains.done"),
      );
      setForms(NO_EDIT, forTarget);
      setAttempt((n) => n + 1);
    } catch (err) {
      if (still(forTarget)) {
        toast.error(failed(err, t("previews.domains.failed")));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function remove(preview: Preview): Promise<void> {
    const forTarget = target;
    const id = preview.pullRequestId;
    const ok = await confirm({
      title: t("previews.delete.confirm.title", { id }),
      description: t("previews.delete.confirm.description"),
      confirmLabel: t("previews.delete.confirm.confirm"),
      destructive: true,
    });
    if (!ok || !still(forTarget)) return;
    setBusy(true);
    try {
      const answer = await api.deletePreview(connectionId, resource.uuid, id);
      if (!still(forTarget)) return;
      toast.success(
        answer.pending
          ? t("previews.delete.pending")
          : t("previews.delete.done", { id }),
      );
      setAttempt((n) => n + 1);
    } catch (err) {
      if (still(forTarget)) {
        toast.error(failed(err, t("previews.delete.failed")));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  if (view.kind !== "list") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border">
          <BackButton
            onClick={() => show({ kind: "list" })}
            label={t("previews.back")}
          />
          <span className="truncate text-xs text-muted-foreground">
            {t("previews.title", { id: view.pullRequestId })}
            {" · "}
            {view.kind === "build"
              ? t("previews.buildLog")
              : t("previews.logs.title")}
          </span>
        </div>
        {view.kind === "build" ? (
          <BuildLogView
            connectionId={connectionId}
            resourceUuid={resource.uuid}
            deploymentUuid={view.deploymentUuid}
            isVisible={isVisible}
            canCancel={canOperate}
          />
        ) : (
          <PreviewLogs
            connectionId={connectionId}
            resourceUuid={resource.uuid}
            pullRequestId={view.pullRequestId}
          />
        )}
      </div>
    );
  }

  let body;
  if (load.kind === "loading") {
    body = <LoadingState label={t("previews.loading")} />;
  } else if (load.kind === "failed") {
    body = (
      <div className="p-4">
        <NoticePanel
          icon={TriangleAlert}
          title={
            load.unsupported ? t("previews.unsupported") : t("previews.failed")
          }
          action={
            load.unsupported ? undefined : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAttempt((n) => n + 1)}
              >
                {t("previews.retry")}
              </Button>
            )
          }
        />
      </div>
    );
  } else if (load.rows.length === 0) {
    body = <EmptyState icon={GitPullRequest} title={t("previews.empty")} />;
  } else {
    body = (
      <PanelList>
        {load.rows.map((p, i) => (
          <div key={p.pullRequestId}>
            <ListRow
              data-preview={p.pullRequestId}
              stripe={i}
              title={t("previews.title", { id: p.pullRequestId })}
              meta={p.pullRequestUrl ?? undefined}
              badges={
                <>
                  <StatusBadge tone={HEALTH_TONE[resourceHealth(p.status)]}>
                    {healthLabel(t, p.status)}
                  </StatusBadge>
                  {p.deploymentStatus ? (
                    <DeploymentStatus t={t as T} status={p.deploymentStatus} />
                  ) : null}
                </>
              }
              aria-label={t("previews.title", { id: p.pullRequestId })}
              trailing={
                canOperate ? (
                  <div className="flex flex-wrap gap-1">
                    {p.deploymentUuid && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          show({
                            kind: "build",
                            pullRequestId: p.pullRequestId,
                            deploymentUuid: p.deploymentUuid!,
                          })
                        }
                      >
                        <Rocket className="size-3.5" />
                        {t("previews.buildLog")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        show({ kind: "logs", pullRequestId: p.pullRequestId })
                      }
                    >
                      <ScrollText className="size-3.5" />
                      {t("previews.logs.action")}
                    </Button>
                    {editable(p) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => editDomains(p)}
                      >
                        <Globe className="size-3.5" />
                        {t("previews.domains.edit")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void remove(p)}
                    >
                      <Trash2 className="size-3.5" />
                      {t("previews.delete.action")}
                    </Button>
                  </div>
                ) : undefined
              }
            >
              {p.domains.length > 0 && (
                <span className="flex flex-col text-xs">
                  {p.domains.map((d) => (
                    <span key={d} className="font-mono">
                      {d}
                    </span>
                  ))}
                </span>
              )}
              {canOperate && !editable(p) && (
                <span className="text-xs text-muted-foreground">
                  {t("previews.domains.noServices")}
                </span>
              )}
            </ListRow>
            {canOperate && forms.editing === p.pullRequestId && (
              <div className="flex flex-col gap-2 border-b border-border p-3">
                {forms.composeDomains ? (
                  forms.composeDomains.map((service, at) => (
                    <TextInput
                      key={service.name}
                      label={t("previews.domains.serviceLabel", {
                        id: p.pullRequestId,
                        name: service.name,
                      })}
                      hint={t("previews.domains.serviceHint")}
                      value={service.domain}
                      error={
                        forms.domainsErrorFor === service.name
                          ? (forms.domainsError ?? undefined)
                          : undefined
                      }
                      onChange={(value) =>
                        setForms({
                          composeDomains: (forms.composeDomains ?? []).map(
                            (s, i) => (i === at ? { ...s, domain: value } : s),
                          ),
                          domainsError: null,
                          domainsErrorFor: null,
                        })
                      }
                    />
                  ))
                ) : (
                  <TextInput
                    label={t("previews.domains.label", {
                      id: p.pullRequestId,
                    })}
                    hint={t("previews.domains.hint")}
                    value={forms.domains}
                    error={forms.domainsError ?? undefined}
                    onChange={(value) =>
                      setForms({ domains: value, domainsError: null })
                    }
                  />
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void saveDomains(p)}
                  >
                    {t("previews.domains.save")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setForms(NO_EDIT)}
                  >
                    {t("previews.domains.cancel")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </PanelList>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolbarBand>
        <RefreshButton
          label={t("previews.refresh")}
          loading={load.kind === "loading"}
          onClick={() => setAttempt((n) => n + 1)}
        />
        {canOperate && !forms.creating && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setForms({ creating: true })}
          >
            <GitPullRequest className="size-3.5" />
            {t("previews.create.open")}
          </Button>
        )}
        {!canOperate && (
          <span className="text-xs text-muted-foreground">
            {t("previews.noAccess")}
          </span>
        )}
      </ToolbarBand>
      {canOperate && forms.creating && (
        <div className="flex flex-col gap-2 border-b border-border p-3">
          <TextInput
            label={t("previews.create.pullRequestId")}
            value={forms.pullRequestId}
            onChange={(value) =>
              setForms({ pullRequestId: value, createError: null })
            }
          />
          <TextInput
            label={t("previews.create.pullRequestUrl")}
            value={forms.pullRequestUrl}
            onChange={(value) =>
              setForms({ pullRequestUrl: value, createError: null })
            }
          />
          <SelectField<GitChoice>
            label={t("previews.create.gitType")}
            value={forms.gitType}
            options={GIT_TYPES.map((value) => ({
              value,
              label:
                value === "auto"
                  ? t("previews.create.gitTypeAuto")
                  : t(`ops.fields.gitType.${value}`),
            }))}
            onChange={(value) => setForms({ gitType: value })}
          />
          {forms.gitType === "bitbucket" && (
            <TextInput
              label={t("previews.create.commit")}
              value={forms.commit}
              onChange={(value) =>
                setForms({ commit: value, createError: null })
              }
            />
          )}
          {dockerImage && (
            <TextInput
              label={t("previews.create.dockerTag")}
              value={forms.dockerTag}
              onChange={(value) =>
                setForms({ dockerTag: value, createError: null })
              }
            />
          )}
          {forms.createError && (
            <NoticePanel tone="destructive" title={forms.createError} />
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void create()}>
              {t("previews.create.submit")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setForms(noForms(target))}
            >
              {t("previews.create.cancel")}
            </Button>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  );
}
