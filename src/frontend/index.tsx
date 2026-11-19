import { useState } from "react";
import { Braces, Plug, Rocket } from "lucide-react";
import {
  useTranslation,
  type TabProps,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { PanelFrame, SideNav } from "@termix-ssh/plugin-sdk/ui";
import { ApiConsoleView } from "./views/ApiConsoleView";
import { ConnectionsView } from "./views/ConnectionsView";
import { ConnectStep } from "./views/ConnectStep";

const TAB_ID = "coolify";

type Section = "connections" | "api";

function CoolifyTab(_props: TabProps) {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("connections");
  return (
    <PanelFrame>
      <div className="flex h-full min-h-0">
        <SideNav
          label={t("tab.sections.label")}
          active={section}
          onSelect={(id) => setSection(id as Section)}
          entries={[
            {
              id: "connections",
              label: t("tab.sections.connections"),
              icon: Plug,
            },
            { id: "api", label: t("apiConsole.title"), icon: Braces },
          ]}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {section === "api" ? <ApiConsoleView /> : <ConnectionsView />}
        </div>
      </div>
    </PanelFrame>
  );
}

export function activate(app: TermixApp): void {
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
  app.registerOnboardingStep({
    id: "connect",
    titleKey: "onboarding.connect.title",
    descriptionKey: "onboarding.connect.description",
    icon: Rocket,
    component: ConnectStep,
    permission: "configure",
    section: "setup",
  });
}
