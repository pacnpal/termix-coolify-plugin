import {
  Boxes,
  Download,
  RefreshCw,
  Rocket,
  SquareTerminal,
  Unlink,
} from "lucide-react";
import type {
  HostDot,
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { createApi } from "./api";
import { forgetPreview, linkOf, useLinkedRow } from "./linked";
import { setLiveApp } from "./live";
import { ConnectStep } from "./views/ConnectStep";
import { CoolifyTab } from "./views/CoolifyTab";
import { HostSection, openCoolify } from "./views/HostSection";
import { ShellTab } from "./views/ShellTab";

const TAB_ID = "coolify";
const IMPORT_ACTION = "coolify.import-from-coolify";

const isLinked = (host: PluginHostRecord) => linkOf(host) !== null;

export function activate(app: TermixApp): void {
  setLiveApp(app);
  app.registerRailItem({
    id: TAB_ID,
    icon: Rocket,
    titleKey: "tab.title",
    kind: "tab",
    permission: "view",
  });
  app.registerTab(TAB_ID, CoolifyTab, {
    icon: Rocket,
    titleKey: "tab.title",
    singleton: true,
    hostless: true,
  });
  // One tab per shell; its data says which resource (views/ShellTab.tsx).
  app.registerTab("coolify-shell", ShellTab, {
    icon: SquareTerminal,
    titleKey: "shellTab.title",
    hostless: true,
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

  // Linked hosts: a card on the host page, a badge and a status dot on the
  // row, and Resources, Sync and Unlink in its menu.
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
    useDot: (host): HostDot | null => {
      const row = useLinkedRow(linkOf(host));
      if (!row) return null;
      if (row.status === "gone") {
        return { tone: "warn", label: app.t("hostDot.gone") };
      }
      if (!row.server.reachable) {
        return { tone: "bad", label: app.t("hostDot.unreachable") };
      }
      if (!row.server.usable) {
        return { tone: "warn", label: app.t("hostDot.degraded") };
      }
      return null;
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
}
