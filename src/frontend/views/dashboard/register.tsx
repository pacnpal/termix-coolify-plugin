import { useEffect, useState } from "react";
import { Rocket } from "lucide-react";
import {
  useTranslation,
  type DashboardCardProps,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  CARD_KINDS,
  readCardConfig,
  type CardKind,
} from "../../../shared/dashboard";
import { CardSettings, CardView } from "./CoolifyCards";

const CARD_ID = "coolify";
/** The homepage plugin's extension point; listed in the manifest's `uses`. */
const WIDGETS = "homepage.widgets";
/** The homepage's grid step, in pixels. */
const GRID = 30;

const ENTRY_KIND: Record<CardKind, "card" | "resource" | "signal"> = {
  overview: "card",
  resource: "resource",
  deployments: "card",
  vulnerabilities: "signal",
};

/** The dashboard card: the entry it was added from says which card it is. */
function CoolifyDashboardCard({
  config,
  setConfig,
  isVisible,
  editMode,
}: DashboardCardProps) {
  return (
    <CardView
      kind={readCardConfig(config, "overview").card}
      config={config}
      setConfig={setConfig}
      active={isVisible && !editMode}
      editMode={editMode}
    />
  );
}

/**
 * Whether the page is shown: the homepage gives a widget no visibility of
 * its own, so a widget reads only while its document is visible.
 */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

interface WidgetProps {
  config?: Record<string, unknown>;
  onConfigUpdate?: (config: Record<string, unknown>) => void;
}

/** The homepage widgets, one per card; each saves its own connection. */
function widgetParts(kind: CardKind) {
  function View({ config, onConfigUpdate }: WidgetProps) {
    const active = usePageVisible();
    return (
      <CardView
        kind={kind}
        config={config}
        setConfig={onConfigUpdate}
        active={active}
      />
    );
  }
  function EditForm({
    config,
    onChange,
  }: {
    config: Record<string, unknown>;
    onChange: (config: Record<string, unknown>) => void;
  }) {
    return (
      <CardSettings
        config={{ ...readCardConfig(config, kind), card: kind }}
        onChange={onChange}
      />
    );
  }
  function Label({ part }: { part: "name" | "description" }) {
    const { t } = useTranslation();
    return (
      <>{t(`dashboard.${kind}.${part === "name" ? "title" : "description"}`)}</>
    );
  }
  return { view: View, editForm: EditForm, label: Label };
}

/**
 * Coolify on Termix's dashboard (one card, placed once per entry, each with
 * its own settings) and on the homepage (the same four cards as widgets).
 * Every card reads through the routes the tab uses and their caches.
 */
export function registerDashboard(app: TermixApp): void {
  app.registerDashboardCard({
    id: CARD_ID,
    titleKey: "dashboardCard.title",
    defaultSize: { w: 4, h: null },
    entries: async (language) =>
      CARD_KINDS.map((kind) => ({
        key: kind,
        title: app.t(`dashboard.${kind}.title`, { lng: language }),
        description: app.t(`dashboard.${kind}.description`, { lng: language }),
        group: app.t("dashboardCard.title", { lng: language }),
        kind: ENTRY_KIND[kind],
        config: { card: kind },
        defaultSize: { w: 4, h: null },
      })),
    component: CoolifyDashboardCard,
  });
  for (const kind of CARD_KINDS) {
    app.registerExtension(WIDGETS, {
      id: `coolify.${kind}`,
      name: app.t(`dashboard.${kind}.title`),
      description: app.t(`dashboard.${kind}.description`),
      category: "monitoring",
      icon: <Rocket size={14} />,
      defaultConfig: {},
      defaultSize: { w: GRID * 10, h: GRID * 8 },
      minSize: { w: GRID * 6, h: GRID * 5 },
      components: widgetParts(kind),
    });
  }
}
