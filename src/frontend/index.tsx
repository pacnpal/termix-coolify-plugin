import { Rocket } from "lucide-react";
import {
  useTranslation,
  type TabProps,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { EmptyState, PanelShell } from "@termix-ssh/plugin-sdk/ui";

const TAB_ID = "coolify";

function CoolifyTab(_props: TabProps) {
  const { t } = useTranslation();
  return (
    <PanelShell icon={<Rocket className="size-4" />} title={t("tab.title")}>
      <EmptyState
        icon={Rocket}
        title={t("tab.empty.title")}
        hint={t("tab.empty.hint")}
      />
    </PanelShell>
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
}
