import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { FileCode, FolderOpen, Globe, Network } from "lucide-react";
import {
  invokeAction,
  useHosts,
  usePluginApi,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  Field,
  GroupHeading,
  Input,
  NoticePanel,
  SelectField,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  failureOf,
  type Api,
  type ContainerChoice,
  type Resource,
  type ResourcePaths,
  type TunnelAnswer,
} from "../api";
import { useCompanions } from "../companions";

type T = (key: string, options?: Record<string, unknown>) => string;

/**
 * Request generations: `begin()` starts a request and answers a check that
 * is true only while that request is the newest one and the view is still
 * mounted, so a late answer never lands on another target.
 */
function useLatest(): () => () => boolean {
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  return useCallback(() => {
    const mine = ++generation.current;
    return () => mine === generation.current;
  }, []);
}

/** The route's resource and Part for a resource row: a Part goes by its service. */
export function targetOf(r: Resource): { uuid: string; part?: string } {
  return r.parentUuid ? { uuid: r.parentUuid, part: r.uuid } : { uuid: r.uuid };
}

const ENGINE_PORTS: Array<[RegExp, number]> = [
  [/postgres/i, 5432],
  [/mysql|mariadb/i, 3306],
  [/mongo/i, 27017],
  [/redis|keydb|dragonfly/i, 6379],
  [/clickhouse/i, 8123],
];

/** A database engine's usual port, as a starting value. */
export function defaultPort(r: Resource): string {
  const engine = r.engine ?? "";
  return String(ENGINE_PORTS.find(([re]) => re.test(engine))?.[1] ?? "");
}

function readPort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text.trim())) return null;
  const port = Number(text.trim());
  return port >= 1 && port <= 65535 ? port : null;
}

const KNOWN_CAUSES: Record<string, string> = {
  "proxy-not-configured": "containerCompanions.errors.proxyNotConfigured",
  "companion-missing": "containerCompanions.errors.companionMissing",
  "bad-container-ip": "containerCompanions.errors.badContainerIp",
  "too-many-tunnels": "containerCompanions.errors.tooManyTunnels",
  "tunnel-in-use": "containerCompanions.errors.tunnelInUse",
};

function describe(t: T, err: unknown): string {
  const failure = failureOf(err);
  const key = failure ? KNOWN_CAUSES[failure.cause] : undefined;
  if (key) return t(key);
  return t("containerCompanions.errors.failed", {
    error: failure?.error || failure?.cause || "",
  });
}

function PortField({
  t,
  value,
  onChange,
}: {
  t: T;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Field label={t("containerCompanions.port")} htmlFor={id} className="w-32">
      <Input
        id={id}
        inputMode="numeric"
        className="font-mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/** Container choices; none can be picked while a request is still out. */
function Choices({
  t,
  choices,
  busy,
  onPick,
}: {
  t: T;
  choices: ContainerChoice[];
  busy: boolean;
  onPick: (name: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        {t("containerCompanions.pickContainer")}
      </span>
      <div className="flex flex-wrap gap-1">
        {choices.map((c) => (
          <Button
            key={c.name}
            size="sm"
            variant="outline"
            disabled={busy || !c.running}
            onClick={() => onPick(c.name)}
          >
            {c.name}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * A port to forward through Tunnels, with Forward and Stop. The forward
 * listens on the Termix server; it is named web:<hostId>:coolify-<uuid>.
 * The open forward is kept by the caller (`open`, `onOpen`), keyed by
 * connection, uuid and revision, so this control can unmount and come back
 * without losing it; an answer lands there even after it unmounted.
 */
export function ForwardControl({
  api,
  connectionId,
  resource,
  open,
  onOpen,
}: {
  api: Api;
  connectionId: number;
  resource: Resource;
  open: TunnelAnswer | null;
  onOpen: (forward: TunnelAnswer | null) => void;
}) {
  const { t } = useTranslation();
  const target = targetOf(resource);
  const [port, setPort] = useState(defaultPort(resource));
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<ContainerChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const begin = useLatest();

  async function forward(container?: string) {
    const value = readPort(port);
    if (value === null) return;
    const current = begin();
    setBusy(true);
    setError(null);
    try {
      const answer = await api.openTunnel(connectionId, target.uuid, {
        port: value,
        ...(target.part ? { part: target.part } : {}),
        ...(container ? { container } : {}),
      });
      if (answer.kind !== "choices") onOpen(answer);
      if (!current()) return;
      setChoices(answer.kind === "choices" ? answer.choices : null);
    } catch (err) {
      if (current()) setError(describe(t, err));
    } finally {
      if (current()) setBusy(false);
    }
  }

  async function stop() {
    // `open` belongs to this target: its keeper is keyed by it.
    if (!open) return;
    const current = begin();
    setBusy(true);
    setError(null);
    try {
      await api.closeTunnel(
        connectionId,
        target.uuid,
        open.targetPort,
        target.part,
      );
      onOpen(null);
    } catch (err) {
      if (current()) setError(describe(t, err));
    } finally {
      if (current()) setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {open ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">
            {t("containerCompanions.listening", {
              bindHost: open.bindHost,
              bindPort: open.bindPort,
            })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void stop()}
          >
            {t("containerCompanions.stop")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <PortField t={t} value={port} onChange={setPort} />
          <Button
            size="sm"
            disabled={busy || readPort(port) === null}
            onClick={() => void forward()}
          >
            {t("containerCompanions.forward")}
          </Button>
        </div>
      )}
      {choices && (
        <Choices
          t={t}
          choices={choices}
          busy={busy}
          onPick={(c) => void forward(c)}
        />
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function WebUiControl({
  api,
  connectionId,
  resource,
}: {
  api: Api;
  connectionId: number;
  resource: Resource;
}) {
  const { t } = useTranslation();
  const target = targetOf(resource);
  const [port, setPort] = useState("80");
  const [scheme, setScheme] = useState<"http" | "https">("http");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [choices, setChoices] = useState<ContainerChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const begin = useLatest();

  async function open(container?: string) {
    const value = readPort(port);
    if (value === null) return;
    const current = begin();
    setBusy(true);
    setError(null);
    setUrl(null);
    try {
      const answer = await api.openWebUi(connectionId, target.uuid, {
        port: value,
        scheme,
        ...(target.part ? { part: target.part } : {}),
        ...(container ? { container } : {}),
      });
      if (!current()) return;
      if (answer.kind === "choices") {
        setChoices(answer.choices);
      } else {
        setChoices(null);
        setUrl(answer.url);
      }
    } catch (err) {
      if (current()) setError(describe(t, err));
    } finally {
      if (current()) setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <PortField t={t} value={port} onChange={setPort} />
        <SelectField
          label={t("containerCompanions.scheme")}
          value={scheme}
          onChange={(v) => setScheme(v === "https" ? "https" : "http")}
          options={[
            { value: "http", label: "http" },
            { value: "https", label: "https" },
          ]}
        />
        <Button
          size="sm"
          disabled={busy || readPort(port) === null}
          onClick={() => void open()}
        >
          {t("containerCompanions.open")}
        </Button>
      </div>
      {choices && (
        <Choices
          t={t}
          choices={choices}
          busy={busy}
          onPick={(c) => void open(c)}
        />
      )}
      {url && (
        <div className="flex flex-col gap-1">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm underline"
          >
            {t("containerCompanions.openLink")}
          </a>
          <span className="text-xs text-muted-foreground">
            {t("containerCompanions.oneTime")}
          </span>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function FilesControl({
  api,
  connectionId,
  resource,
}: {
  api: Api;
  connectionId: number;
  resource: Resource;
}) {
  const { t } = useTranslation();
  const { hosts } = useHosts();
  const target = targetOf(resource);
  const [paths, setPaths] = useState<ResourcePaths | null>(null);
  const [error, setError] = useState<string | null>(null);
  const begin = useLatest();

  useEffect(() => {
    const current = begin();
    setPaths(null);
    setError(null);
    api
      .resourcePaths(connectionId, target.uuid, target.part)
      .then((p) => current() && setPaths(p))
      .catch((err) => current() && setError(describe(t, err)));
  }, [api, begin, connectionId, target.uuid, target.part, t]);

  // Host ids may be strings in the shell, so they are compared as text.
  const host = paths
    ? hosts.find((h) => String(h.id) === String(paths.hostId))
    : undefined;

  async function openIn(
    action: "files.openHost" | "files.openEditor",
    path: string,
  ) {
    if (!host) return;
    setError(null);
    try {
      await invokeAction(action, host, path);
    } catch {
      setError(t("containerCompanions.errors.openFailed"));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!paths || !host}
          onClick={() => paths && void openIn("files.openHost", paths.dataDir)}
        >
          <FolderOpen className="size-3.5" />
          {t("containerCompanions.browse")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!paths || !host}
          onClick={() =>
            paths && void openIn("files.openEditor", paths.composeFile)
          }
        >
          <FileCode className="size-3.5" />
          {t("containerCompanions.editCompose")}
        </Button>
      </div>
      {paths && paths.volumes.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            {t("containerCompanions.volumes")}
          </span>
          <div className="flex flex-wrap gap-1">
            {paths.volumes.map((path) => (
              <Button
                key={path}
                size="sm"
                variant="ghost"
                disabled={!host}
                onClick={() => void openIn("files.openHost", path)}
              >
                {t("containerCompanions.volume", { path })}
              </Button>
            ))}
          </div>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

interface ContainerCompanionsProps {
  connectionId: number;
  resource: Resource;
  /** The connection's revision: a changed target starts the view anew. */
  revision: string | null;
  /**
   * coolify.operate and an operate (or higher) grant on this connection:
   * the effective permission ResourceDetail uses, not the global one alone.
   */
  canOperate: boolean;
}

/**
 * File Manager, Tunnels and Reverse Proxy actions on a resource's
 * container. Each shows only while its plugin runs. Browse files needs
 * coolify.view; Reach from here and Open web UI reach the server over SSH,
 * so they need coolify.operate, and the backend also checks the person's
 * own access to the Linked host. Keyed by connection, uuid and revision, so
 * no answer, open forward or link carries over to another target.
 */
export function ContainerCompanions(props: ContainerCompanionsProps) {
  const target = `${props.connectionId}:${props.resource.uuid}:${props.revision ?? ""}`;
  return <ContainerCompanionsFor key={target} {...props} />;
}

function ContainerCompanionsFor({
  connectionId,
  resource,
  canOperate,
}: ContainerCompanionsProps) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const map = useCompanions();
  const [panel, setPanel] = useState<"tunnel" | "web" | null>(null);
  // Held here, above the panel switch: this view is keyed by its target.
  const [forward, setForward] = useState<TunnelAnswer | null>(null);

  // A service row has its own containers through its Parts.
  if (!map || resource.kind === "service") return null;
  const tunnels = canOperate && map.tunnels;
  const web = canOperate && map.reverseProxy;
  if (!map.files && !tunnels && !web) return null;

  return (
    <div className="flex flex-col gap-3 p-3" data-companions="container">
      <GroupHeading title={t("containerCompanions.title")} />
      {map.files && (
        <FilesControl
          api={api}
          connectionId={connectionId}
          resource={resource}
        />
      )}
      {(tunnels || web) && (
        <div className="flex flex-wrap gap-2">
          {tunnels && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPanel(panel === "tunnel" ? null : "tunnel")}
            >
              <Network className="size-3.5" />
              {t("containerCompanions.reach")}
            </Button>
          )}
          {web && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPanel(panel === "web" ? null : "web")}
            >
              <Globe className="size-3.5" />
              {t("containerCompanions.webUi")}
            </Button>
          )}
        </div>
      )}
      {panel === "tunnel" && tunnels && (
        <div className="flex flex-col gap-2">
          <ForwardControl
            api={api}
            connectionId={connectionId}
            resource={resource}
            open={forward}
            onOpen={setForward}
          />
          <NoticePanel title={t("containerCompanions.localNote")} />
        </div>
      )}
      {panel === "web" && web && (
        <WebUiControl
          api={api}
          connectionId={connectionId}
          resource={resource}
        />
      )}
    </div>
  );
}
