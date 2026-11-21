import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, KeyRound, SquareTerminal, TriangleAlert } from "lucide-react";
import type { TabProps } from "@termix-ssh/plugin-sdk/frontend";
import type { PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";
import {
  useHosts,
  usePluginApi,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  ListRow,
  LoadingState,
  NoticePanel,
  PanelFrame,
  PanelList,
  PluginComponent,
  StatusBadge,
  copyToClipboard,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  failureOf,
  type ContainerChoice,
  type ShellAnswer,
} from "../api";

/** What a coolify-shell tab was opened with. */
export interface ShellTabData {
  connectionId: number;
  uuid: string;
  part?: string;
  container?: string;
  console: "shell" | "db";
  /** The connection's target hash when opened; a new one starts the tab anew. */
  revision?: string;
}

const UUID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,255}$/;

/** The tab's data, or null when it names nothing this tab can open. */
export function shellTabData(
  data: Record<string, unknown> | undefined,
): ShellTabData | null {
  const id = Number(data?.connectionId);
  const uuid = data?.uuid;
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof uuid !== "string" || !UUID.test(uuid)) return null;
  const out: ShellTabData = {
    connectionId: id,
    uuid,
    console: data?.console === "db" ? "db" : "shell",
  };
  if (typeof data?.part === "string" && UUID.test(data.part)) {
    out.part = data.part;
  }
  if (typeof data?.container === "string" && NAME.test(data.container)) {
    out.container = data.container;
  }
  if (typeof data?.revision === "string" && UUID.test(data.revision)) {
    out.revision = data.revision;
  }
  return out;
}

/** One key per resource and target: the picked container belongs to it. */
function keyOf(opened: ShellTabData): string {
  return [
    opened.connectionId,
    opened.uuid,
    opened.part ?? "",
    opened.console,
    opened.container ?? "",
    opened.revision ?? "",
  ].join(":");
}

/**
 * A host the actor can see, by the id the backend answers. Shell host ids
 * may be strings, so they are compared as text.
 */
function useHostById(hostId: number | null): PluginHostRecord | null {
  const { hosts } = useHosts();
  return useMemo(
    () =>
      hostId === null
        ? null
        : (hosts.find((h) => String(h.id) === String(hostId)) ?? null),
    [hosts, hostId],
  );
}

/** Causes the tab explains in its own words; others show the server's text. */
const KNOWN_CAUSES = [
  "not-linked",
  "not-running",
  "container-not-found",
  "host-key",
  "no-host-access",
] as const;

type State =
  | { kind: "loading" }
  | { kind: "command"; answer: ShellAnswer }
  | { kind: "choices"; choices: ContainerChoice[] }
  | {
      kind: "failed";
      cause: string;
      hostId: number | null;
      fingerprints: string[];
    };

function readFailure(err: unknown): Extract<State, { kind: "failed" }> {
  const failure = failureOf(err);
  const data = (err as { response?: { data?: Record<string, unknown> } })
    ?.response?.data;
  const hostId = Number(data?.hostId);
  const fingerprints = Array.isArray(data?.fingerprints)
    ? data.fingerprints.filter((f): f is string => typeof f === "string")
    : [];
  return {
    kind: "failed",
    cause: failure?.cause ?? "failed",
    hostId: Number.isSafeInteger(hostId) && hostId > 0 ? hostId : null,
    fingerprints,
  };
}

function CommandBlock({ command }: { command: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <code className="block break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs">
        {command}
      </code>
      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void copyToClipboard(command).then((ok) => setCopied(ok));
          }}
        >
          <Copy className="size-3.5" />
          {copied ? t("shellTab.copied") : t("shellTab.copy")}
        </Button>
      </div>
    </div>
  );
}

/** Shown in place of the terminal while SSH Terminal isn't running. */
function NoTerminal({ command }: { command: string }) {
  const { t } = useTranslation();
  return (
    <div className="p-4">
      <NoticePanel
        icon={SquareTerminal}
        title={t("shellTab.noTerminal.title")}
        tone="warning"
      >
        <p className="mb-3">{t("shellTab.noTerminal.hint")}</p>
        <CommandBlock command={command} />
      </NoticePanel>
    </div>
  );
}

function Terminal({
  answer,
  isVisible,
}: {
  answer: ShellAnswer;
  isVisible: boolean;
}) {
  const { t } = useTranslation();
  const host = useHostById(answer.hostId);
  const fallback = <NoTerminal command={answer.command} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {answer.note === "no-console" && (
        <p className="border-b px-3 py-2 text-xs text-muted-foreground">
          {t("shellTab.noConsole")}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {host ? (
          <PluginComponent
            id="terminal.view"
            hostConfig={host}
            executeCommand={answer.command}
            isVisible={isVisible}
            fallback={fallback}
          />
        ) : (
          fallback
        )}
      </div>
    </div>
  );
}

function Picker({
  choices,
  onPick,
}: {
  choices: ContainerChoice[];
  onPick: (name: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 p-3">
      <div>
        <h3 className="text-sm font-medium">{t("shellTab.pick.title")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("shellTab.pick.hint")}
        </p>
      </div>
      <PanelList>
        {choices.map((c, i) => (
          <ListRow
            key={c.name}
            stripe={i}
            title={c.name}
            meta={c.part ?? undefined}
            badges={
              <StatusBadge tone={c.running ? "ok" : "idle"}>
                {c.running
                  ? t("shellTab.pick.running")
                  : t("shellTab.pick.stopped")}
              </StatusBadge>
            }
            aria-label={c.name}
            onClick={() => onPick(c.name)}
          />
        ))}
      </PanelList>
    </div>
  );
}

function Failed({
  failure,
  onTrust,
  onRetry,
  onChangeContainer,
}: {
  failure: Extract<State, { kind: "failed" }>;
  onTrust: (() => void) | null;
  onRetry: () => void;
  /** Null when no container was picked, so there is nothing to change. */
  onChangeContainer: (() => void) | null;
}) {
  const { t } = useTranslation();
  const known = (KNOWN_CAUSES as readonly string[]).includes(failure.cause);
  const hostKey = failure.cause === "host-key";
  return (
    <div className="p-4">
      <NoticePanel
        icon={hostKey ? KeyRound : TriangleAlert}
        title={t(`shellTab.errors.${known ? failure.cause : "failed"}`)}
        tone={hostKey ? "warning" : "default"}
        action={
          <div className="flex gap-2">
            {hostKey && onTrust && (
              <Button size="sm" onClick={onTrust}>
                {t("shellTab.trust")}
              </Button>
            )}
            {onChangeContainer && (
              <Button size="sm" variant="outline" onClick={onChangeContainer}>
                {t("shellTab.changeContainer")}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t("shellTab.retry")}
            </Button>
          </div>
        }
      >
        {hostKey && failure.fingerprints.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs">{t("shellTab.fingerprints")}</span>
            {failure.fingerprints.map((f) => (
              <code key={f} className="break-all font-mono text-xs">
                {f}
              </code>
            ))}
          </div>
        )}
      </NoticePanel>
    </div>
  );
}

/**
 * The coolify-shell tab: asks the backend for the docker exec command, then
 * embeds SSH Terminal's terminal.view on the Linked host to run it. Without
 * SSH Terminal it shows the command to copy. Its state, the picked container
 * too, belongs to one resource and revision: new tab data starts it anew.
 */
export function ShellTab(props: TabProps) {
  const { t } = useTranslation();
  const opened = useMemo(
    () => shellTabData(props.tab?.data),
    [props.tab?.data],
  );
  if (!opened) {
    return (
      <PanelFrame>
        <EmptyState icon={SquareTerminal} title={t("shellTab.empty")} />
      </PanelFrame>
    );
  }
  return <ShellView key={keyOf(opened)} {...props} opened={opened} />;
}

function ShellView(props: TabProps & { opened: ShellTabData }) {
  const { opened } = props;
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [container, setContainer] = useState<string | undefined>(
    opened.container,
  );
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const failedHost = useHostById(state.kind === "failed" ? state.hostId : null);

  // Request generation: only the newest load may set the state, so an older
  // answer (for a container since changed) that ends last is dropped.
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setState({ kind: "loading" });
    const body = {
      console: opened.console,
      ...(opened.part ? { part: opened.part } : {}),
      ...(container ? { container } : {}),
    };
    try {
      const result = await api.shell(opened.connectionId, opened.uuid, body);
      if (mine !== generation.current) return;
      if (result.kind === "choices") {
        setState({ kind: "choices", choices: result.choices });
      } else {
        const { kind: _kind, ...answer } = result;
        setState({ kind: "command", answer });
      }
    } catch (err) {
      if (mine !== generation.current) return;
      setState(readFailure(err));
    }
  }, [api, opened, container]);

  useEffect(() => {
    void load();
  }, [load, attempt]);

  let body;
  if (state.kind === "loading") {
    body = <LoadingState label={t("shellTab.loading")} />;
  } else if (state.kind === "choices") {
    body = <Picker choices={state.choices} onPick={setContainer} />;
  } else if (state.kind === "failed") {
    body = (
      <Failed
        failure={state}
        onTrust={failedHost ? () => props.shell.connectHost(failedHost) : null}
        onRetry={() => setAttempt((n) => n + 1)}
        // Clearing the pick asks for the containers again: the picker.
        onChangeContainer={container ? () => setContainer(undefined) : null}
      />
    );
  } else {
    body = <Terminal answer={state.answer} isVisible={props.isVisible} />;
  }
  return <PanelFrame>{body}</PanelFrame>;
}
