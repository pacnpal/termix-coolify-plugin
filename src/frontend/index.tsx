import { Rocket } from "lucide-react";
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { ConnectStep } from "./views/ConnectStep";
import { CoolifyTab } from "./views/CoolifyTab";

const TAB_ID = "coolify";

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
