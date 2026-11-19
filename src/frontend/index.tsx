import { Rocket } from "lucide-react";
import type { TabProps, TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { PanelFrame } from "@termix-ssh/plugin-sdk/ui";
import { ConnectionsView } from "./views/ConnectionsView";
import { ConnectStep } from "./views/ConnectStep";

const TAB_ID = "coolify";

function CoolifyTab(_props: TabProps) {
  return (
    <PanelFrame>
      <ConnectionsView />
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
