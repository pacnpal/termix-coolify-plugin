import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clock,
  Download,
  Radio,
  ScrollText,
  TriangleAlert,
} from "lucide-react";
import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  ListRow,
  LoadingState,
  NoticePanel,
  PanelList,
  PanelSearch,
  RefreshButton,
  StatusBadge,
  ToolbarBand,
  ToolbarSelect,
} from "@termix-ssh/plugin-sdk/ui";
import {
  choicesOf,
  createApi,
  failureOf,
  type ContainerChoice,
  type LogSource,
  type Resource,
} from "../api";
import { openSocket } from "../socket";

/** Line counts offered; the backend caps any count at 10,000. */
export const LINE_COUNTS = ["100", "500", "1000", "5000", "10000"] as const;
type LineCount = (typeof LINE_COUNTS)[number];

/** WebSocket.OPEN, which a frame's socket shares. */
const OPEN = 1;

/** Causes the view explains in its own words; others say it failed. */
const KNOWN_CAUSES = [
  "not-linked",
  "no-host-access",
  "host-key",
  "container-not-found",
  "locked",
  "forbidden",
  "not-found",
  "target-changed",
] as const;

/** Waits before each automatic reconnect of a lost follow; then only the button. */
const RECONNECT_DELAYS_MS = [1_000, 3_000, 9_000];
/** The close code the backend refuses with: access or the target changed. */
const REFUSED = 1008;

type Snapshot =
  | { kind: "loading" }
  | {
      kind: "logs";
      source: LogSource;
      lines: string[];
      container: string | null;
    }
  | { kind: "choices"; choices: ContainerChoice[] }
  | { kind: "failed"; cause: string };

type Follow =
  | { kind: "off" }
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "ended" }
  /** The socket closed on its own (not a refusal): retried, then Reconnect. */
  | { kind: "lost" }
  | { kind: "failed"; cause: string };

function causeKey(cause: string): string {
  return (KNOWN_CAUSES as readonly string[]).includes(cause) ? cause : "failed";
}

/** The text for a 1008 close: its cause, or that access or the target changed. */
function refusalKey(reason: string): string {
  return (KNOWN_CAUSES as readonly string[]).includes(reason)
    ? reason
    : "refused";
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The uuid and Part the backend reads: a Part by its service's uuid. */
function targetOf(resource: Resource): { uuid: string; part?: string } {
  return resource.parentUuid
    ? { uuid: resource.parentUuid, part: resource.uuid }
    : { uuid: resource.uuid };
}

/** Saves the lines as a text file, through the shell in a frame. */
function download(name: string, lines: readonly string[]): void {
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.replace(/[^A-Za-z0-9_.-]+/g, "-") || "coolify"}-logs.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * A resource's container logs: a snapshot with a line count, timestamps,
 * search and download, labelled "from Coolify" or "from the server over SSH",
 * and a live follow over the /logs socket. The follow runs only while the
 * view is shown and stops when it hides, unmounts or is turned off.
 */
export function LogsView({
  connectionId,
  resource,
  isVisible,
}: {
  connectionId: number;
  resource: Resource;
  isVisible: boolean;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const target = useMemo(() => targetOf(resource), [resource]);
  const [count, setCount] = useState<LineCount>("100");
  const [timestamps, setTimestamps] = useState(false);
  const [container, setContainer] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [following, setFollowing] = useState(false);
  const [follow, setFollow] = useState<Follow>({ kind: "off" });
  // Bumped to open a new follow socket: Reconnect and the automatic retries.
  const [followAttempt, setFollowAttempt] = useState(0);
  const followRetries = useRef(0);
  // Where the followed lines come from, apart from the snapshot's source:
  // a follow is always SSH, even on a snapshot read through Coolify. A new
  // snapshot replaces the lines, so it clears this.
  const [followSource, setFollowSource] = useState<LogSource | null>(null);
  const max = Number(count);

  // Request generation: only the newest load may set the snapshot, so an
  // older answer that ends last (or after unmount) is dropped.
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setSnapshot({ kind: "loading" });
    setFollowSource(null);
    try {
      const result = await api.logs(connectionId, target.uuid, {
        lines: max,
        timestamps,
        ...(target.part ? { part: target.part } : {}),
        ...(container ? { container } : {}),
      });
      if (mine !== generation.current) return;
      if (result.kind === "choices") {
        setSnapshot({ kind: "choices", choices: result.choices });
        return;
      }
      setSnapshot({
        kind: "logs",
        source: result.source,
        lines: splitLines(result.text),
        container: result.container ?? null,
      });
    } catch (err) {
      if (mine !== generation.current) return;
      setSnapshot({ kind: "failed", cause: failureOf(err)?.cause ?? "" });
    }
  }, [api, connectionId, target, max, timestamps, container]);

  useEffect(() => {
    void load();
  }, [load, attempt]);

  const ready = snapshot.kind === "logs";
  const followContainer = snapshot.kind === "logs" ? snapshot.container : null;

  useEffect(() => {
    if (!following || !isVisible || !ready) return;
    let socket: WebSocket | null = null;
    // This socket's generation: set on cleanup, after which nothing it
    // sends or reports reaches the view.
    let stopped = false;
    // An "ended" or "error" message came first: the close that follows is
    // expected.
    let settled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    setFollow({ kind: "connecting" });
    void openSocket("/logs").then((opened) => {
      if (stopped) {
        opened?.close();
        return;
      }
      if (!opened) {
        setFollow({ kind: "failed", cause: "" });
        return;
      }
      socket = opened;
      opened.onopen = () => {
        opened.send(
          JSON.stringify({
            type: "subscribe",
            connectionId,
            uuid: target.uuid,
            ...(target.part ? { part: target.part } : {}),
            ...(followContainer ? { container: followContainer } : {}),
            timestamps,
          }),
        );
      };
      opened.onmessage = (event) => {
        if (stopped) return;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (message.type === "started") {
          followRetries.current = 0;
          setFollow({ kind: "live" });
          setFollowSource(message.source === "coolify" ? "coolify" : "ssh");
        } else if (message.type === "choices") {
          // Several containers match over SSH: show the picker. Picking one
          // reloads with that container, and the follow subscribes again
          // with it (kept for this resource while the view lives).
          const choices = choicesOf(message);
          if (choices) setSnapshot({ kind: "choices", choices });
        } else if (message.type === "ended") {
          settled = true;
          setFollow({ kind: "ended" });
        } else if (message.type === "error") {
          settled = true;
          setFollow({ kind: "failed", cause: String(message.cause ?? "") });
        } else if (message.type === "lines" && Array.isArray(message.lines)) {
          const added = message.lines.filter(
            (l): l is string => typeof l === "string",
          );
          setSnapshot((s) =>
            s.kind === "logs"
              ? { ...s, lines: [...s.lines, ...added].slice(-max) }
              : s,
          );
        }
      };
      opened.onclose = (event?: { code?: number; reason?: string }) => {
        if (stopped || settled) return;
        settled = true;
        if (event?.code === REFUSED) {
          // A refusal: say why, and only Reconnect starts it again.
          setFollow({ kind: "failed", cause: refusalKey(event.reason ?? "") });
          return;
        }
        setFollow({ kind: "lost" });
        const wait = RECONNECT_DELAYS_MS[followRetries.current];
        if (wait === undefined) return;
        followRetries.current += 1;
        retry = setTimeout(() => {
          if (!stopped) setFollowAttempt((n) => n + 1);
        }, wait);
      };
    });
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      setFollow({ kind: "off" });
      if (!socket) return;
      try {
        if (socket.readyState === OPEN) {
          socket.send(JSON.stringify({ type: "unsubscribe" }));
        }
      } catch {
        // Closing anyway.
      }
      socket.close();
    };
  }, [
    following,
    followAttempt,
    isVisible,
    ready,
    followContainer,
    connectionId,
    target,
    timestamps,
    max,
  ]);

  const shown = useMemo(() => {
    if (snapshot.kind !== "logs") return [];
    const needle = search.trim().toLowerCase();
    return needle
      ? snapshot.lines.filter((l) => l.toLowerCase().includes(needle))
      : snapshot.lines;
  }, [snapshot, search]);

  const toolbar = (
    <ToolbarBand>
      <div className="flex flex-wrap items-center gap-2">
        <ToolbarSelect
          value={count}
          onChange={setCount}
          label={t("logs.lines")}
          options={LINE_COUNTS.map((value) => ({
            value,
            label: t("logs.linesOption", { count: Number(value) }),
          }))}
        />
        <Button
          size="sm"
          variant={timestamps ? "default" : "outline"}
          aria-pressed={timestamps}
          onClick={() => setTimestamps((v) => !v)}
        >
          <Clock className="size-3.5" />
          {t("logs.timestamps")}
        </Button>
        <Button
          size="sm"
          variant={following ? "default" : "outline"}
          aria-pressed={following}
          disabled={!ready && !following}
          onClick={() => {
            followRetries.current = 0;
            setFollowing((v) => !v);
          }}
        >
          <Radio className="size-3.5" />
          {t("logs.follow")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={snapshot.kind !== "logs" || snapshot.lines.length === 0}
          onClick={() => {
            if (snapshot.kind === "logs")
              download(resource.name, snapshot.lines);
          }}
        >
          <Download className="size-3.5" />
          {t("logs.download")}
        </Button>
        <RefreshButton
          label={t("logs.refresh")}
          loading={snapshot.kind === "loading"}
          onClick={() => setAttempt((n) => n + 1)}
        />
        {snapshot.kind === "logs" && (
          <StatusBadge
            tone={
              (followSource ?? snapshot.source) === "coolify" ? "info" : "idle"
            }
          >
            {t(`logs.source.${followSource ?? snapshot.source}`)}
          </StatusBadge>
        )}
        {follow.kind === "live" && (
          <StatusBadge tone="ok">{t("logs.following")}</StatusBadge>
        )}
        {follow.kind === "ended" && (
          <StatusBadge tone="idle">{t("logs.followEnded")}</StatusBadge>
        )}
        {follow.kind === "failed" && (
          <StatusBadge tone="warn">
            {t(
              `logs.errors.${follow.cause === "refused" ? "refused" : causeKey(follow.cause)}`,
            )}
          </StatusBadge>
        )}
        {follow.kind === "lost" && (
          <StatusBadge tone="warn">{t("logs.followLost")}</StatusBadge>
        )}
        {following && (follow.kind === "failed" || follow.kind === "lost") && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              followRetries.current = 0;
              setFollowAttempt((n) => n + 1);
            }}
          >
            {t("logs.reconnect")}
          </Button>
        )}
      </div>
      <PanelSearch
        value={search}
        onChange={setSearch}
        placeholder={t("logs.search")}
      />
    </ToolbarBand>
  );

  let body;
  if (snapshot.kind === "loading") {
    body = <LoadingState label={t("logs.loading")} />;
  } else if (snapshot.kind === "failed") {
    body = (
      <div className="p-4">
        <NoticePanel
          icon={TriangleAlert}
          title={t(`logs.errors.${causeKey(snapshot.cause)}`)}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAttempt((n) => n + 1)}
            >
              {t("logs.retry")}
            </Button>
          }
        />
      </div>
    );
  } else if (snapshot.kind === "choices") {
    body = (
      <div className="flex flex-col gap-2 p-3">
        <div>
          <h3 className="text-sm font-medium">{t("logs.pick.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("logs.pick.hint")}</p>
        </div>
        <PanelList>
          {snapshot.choices.map((c, i) => (
            <ListRow
              key={c.name}
              stripe={i}
              title={c.name}
              meta={c.part ?? undefined}
              aria-label={c.name}
              onClick={() => setContainer(c.name)}
            />
          ))}
        </PanelList>
      </div>
    );
  } else if (snapshot.lines.length === 0) {
    body = <EmptyState icon={ScrollText} title={t("logs.empty")} />;
  } else if (shown.length === 0) {
    body = <EmptyState icon={ScrollText} title={t("logs.noMatch")} />;
  } else {
    body = (
      <div
        className="min-h-0 flex-1 overflow-auto bg-muted/30 px-3 py-2 font-mono text-xs leading-5"
        role="log"
        aria-label={t("logs.title")}
      >
        {shown.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            {line}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      {body}
    </div>
  );
}
