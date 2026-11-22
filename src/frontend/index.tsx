import {
  Activity,
  Boxes,
  Download,
  RefreshCw,
  Rocket,
  ScrollText,
  SquareTerminal,
  Unlink,
} from "lucide-react";
import type {
  HostDot,
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { ACTIVITY_TYPES } from "../shared/activity";
import { createApi } from "./api";
import { forgetPreview, linkOf, useHostProblem } from "./linked";
import { keepSocketTarget } from "./socket";
import { registerToolbarStatus } from "./toolbar-status";
import { ActivityPanel } from "./views/ActivityPanel";
import { ConnectStep } from "./views/ConnectStep";
import { CoolifyTab } from "./views/CoolifyTab";
import { HostSection, openCoolify } from "./views/HostSection";
import { ShellTab } from "./views/ShellTab";
import { TerminalCompanion } from "./views/TerminalCompanion";
import { TunnelsCoolifyView } from "./views/TunnelsCoolifyView";
import { railBadge } from "./views/useAttention";

const TAB_ID = "coolify";
const PANEL_ID = "coolify-activity";
const IMPORT_ACTION = "coolify.import-from-coolify";

const isLinked = (host: PluginHostRecord) => linkOf(host) !== null;

export function activate(app: TermixApp): void {
  /**
   * A Linked host's dot: alarm when Coolify can't reach its server, warn
   * when the server is gone, not usable or runs a degraded resource. An
   * ordinary host gets none and makes no request.
   */
  function useHostDot(host: PluginHostRecord): HostDot | null {
    const problem = useHostProblem(linkOf(host));
    switch (problem?.kind) {
      case "unreachable":
        return { tone: "bad", label: app.t("hostDot.unreachable") };
      case "gone":
        return { tone: "warn", label: app.t("hostDot.gone") };
      case "unusable":
        return { tone: "warn", label: app.t("hostDot.degraded") };
      case "degraded":
        return {
          tone: "warn",
          label: app.t("hostDot.resourcesDegraded", { count: problem.count }),
        };
      default:
        return null;
    }
  }

  // The Logs view's live follow opens /plugin-ws/coolify/logs through it.
  keepSocketTarget(app);
  // The badge counts running deployments plus recent failures; it reads the
  // same cached GET /attention as the activity panel (views/useAttention.ts).
  app.registerRailItem({
    id: TAB_ID,
    icon: Rocket,
    titleKey: "tab.title",
    kind: "tab",
    permission: "view",
    useBadge: railBadge({
      api: createApi(app.api),
      hasPermission: (name) => app.hasPermission(name),
    }),
  });
  app.registerRailItem({
    id: PANEL_ID,
    icon: Activity,
    titleKey: "activityPanel.title",
    kind: "panel",
    permission: "view",
    after: TAB_ID,
    rightDockable: true,
  });
  app.registerPanel(PANEL_ID, ActivityPanel);
  app.registerTab(TAB_ID, CoolifyTab, {
    icon: Rocket,
    titleKey: "tab.title",
    singleton: true,
    hostless: true,
    // Shells and deploys in Termix's recent activity open this tab.
    activityTypes: Object.values(ACTIVITY_TYPES),
  });
  // One tab per shell; its data says which resource (views/ShellTab.tsx).
  app.registerTab("coolify-shell", ShellTab, {
    icon: SquareTerminal,
    titleKey: "shellTab.title",
    hostless: true,
  });
  // The container's name and status in a coolify-shell tab's toolbar.
  registerToolbarStatus(app);
  // Beside a terminal on a Linked host: that server's resources, with Shell,
  // Logs, Restart and Deploy. Other hosts get no panel and no request.
  app.registerCompanion("coolify", TerminalCompanion, {
    icon: Rocket,
    titleKey: "terminalCompanion.title",
    tabTypes: ["terminal"],
    when: (_tab, host) => !!host && isLinked(host),
  });
  app.registerOnboardingStep({
    id: "connect",
    titleKey: "onboarding.connect.title",
    descriptionKey: "onboarding.connect.description",
    icon: Rocket,
    component: ConnectStep,
    permission: "configure",
    section: "setup",
  });

  // Linked hosts: a card on the host page, a badge, a status dot and a
  // Coolify button on the row, and Resources, Sync and Unlink in its menu.
  app.registerHostSection({
    id: "coolify",
    titleKey: "hostSection.title",
    when: isLinked,
    component: HostSection,
  });
  app.registerHostBadge({
    id: "coolify",
    when: isLinked,
    useValue: (host) =>
      isLinked(host)
        ? {
            shape: "badge",
            label: app.t("hostBadge.label"),
            tooltip: app.t("hostBadge.tooltip"),
          }
        : null,
    // The one host dot path: the layout merges every plugin's dots into one.
    useDot: useHostDot,
  });
  // "Coolify" on a Linked host: the Resources list filtered to its server.
  app.registerHostAction({
    id: "coolify.open",
    titleKey: "hostAction.title",
    icon: Rocket,
    kind: "open",
    when: isLinked,
    run: (host, shell) => {
      const link = linkOf(host);
      if (link) openCoolify(shell, "resources", link);
    },
  });
  app.registerHostContextMenuItem({
    id: "coolify.resources",
    titleKey: "hostMenu.resources",
    icon: Boxes,
    when: isLinked,
    run: (host, shell) => {
      const link = linkOf(host);
      if (link) openCoolify(shell, "resources", link);
    },
  });
  app.registerHostContextMenuItem({
    id: "coolify.sync",
    titleKey: "hostMenu.sync",
    icon: RefreshCw,
    when: isLinked,
    run: (host, shell) => {
      const link = linkOf(host);
      if (link) openCoolify(shell, "sync", link);
    },
  });
  app.registerHostContextMenuItem({
    id: "coolify.unlink",
    titleKey: "hostMenu.unlink",
    icon: Unlink,
    when: isLinked,
    run: (host) => {
      const link = linkOf(host);
      if (!link) return;
      void (async () => {
        const ok = await app.confirm({
          title: app.t("unlinkConfirm.title", { name: host.name ?? host.ip }),
          description: app.t("unlinkConfirm.description"),
          confirmLabel: app.t("unlinkConfirm.confirm"),
          destructive: false,
        });
        if (!ok) return;
        try {
          await createApi(app.api).unlinkServer(
            link.connectionId,
            link.serverUuid,
            false,
          );
          forgetPreview(link.connectionId);
        } catch {
          // The route answers 403 without coolify.configure; nothing to undo.
        }
      })();
    },
  });

  // Command palette. Deploy, Open shell and Logs open the Resources list to
  // pick from: the tab data says what a pick does (CoolifyTab's targetOf).
  // Sync servers opens the sync preview.
  app.registerPaletteGroup({
    id: "coolify",
    titleKey: "palette.group",
    load: () => [
      {
        id: "coolify.deploy",
        title: app.t("palette.deploy"),
        icon: Rocket,
        keywords: ["coolify", "deploy", "redeploy", "rebuild"],
        run: ({ shell }) =>
          shell.openSingletonTab(TAB_ID, { data: { section: "resources" } }),
      },
      {
        id: "coolify.shell",
        title: app.t("palette.shell"),
        icon: SquareTerminal,
        keywords: ["coolify", "shell", "terminal", "exec", "container"],
        run: ({ shell }) =>
          shell.openSingletonTab(TAB_ID, {
            data: { section: "resources", open: "shell" },
          }),
      },
      {
        id: "coolify.logs",
        title: app.t("palette.logs"),
        icon: ScrollText,
        keywords: ["coolify", "logs", "container"],
        run: ({ shell }) =>
          shell.openSingletonTab(TAB_ID, {
            data: { section: "resources", tab: "logs" },
          }),
      },
      {
        id: "coolify.sync",
        title: app.t("palette.sync"),
        icon: RefreshCw,
        keywords: ["coolify", "sync", "servers", "hosts", "import"],
        run: ({ shell }) =>
          shell.openSingletonTab(TAB_ID, { data: { section: "sync" } }),
      },
    ],
  });

  // Hosts > Import: opens the sync preview.
  app.registerAction(
    IMPORT_ACTION,
    () => app.tabs.openSingletonTab(TAB_ID, { data: { section: "sync" } }),
    { permission: "configure" },
  );
  app.registerSlotContribution("hosts.importMenu", {
    actionId: IMPORT_ACTION,
    titleKey: "importMenu.title",
    icon: Download,
    kind: "button",
  });

  // A Coolify view inside the Tunnels tab, only for people who may forward
  // container ports (coolify.operate); the backend checks again. It waits
  // for the permission without holding up the rest of activate.
  let disposed = false;
  app.onDispose(() => {
    disposed = true;
  });
  void app.hasPermission("operate").then((allowed) => {
    if (!allowed || disposed) return;
    app.registerExtension("tunnels.views", {
      id: "coolify.resources",
      title: app.t("containerCompanions.viewTitle"),
      order: 100,
      components: { view: TunnelsCoolifyView },
    });
  });
}
