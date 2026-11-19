import { useMemo } from "react";
import {
  usePluginApi,
  useTranslation,
  type OnboardingStepProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { Button, NoticePanel, PANEL, cn } from "@termix-ssh/plugin-sdk/ui";
import { createApi } from "../api";
import {
  ConnectionFields,
  FormError,
  ProbeChecklist,
  useConnectionForm,
} from "./ConnectionForm";

/** Onboarding: connect a first Coolify instance. Optional, so Next always works. */
export function ConnectStep(_props: OnboardingStepProps) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const form = useConnectionForm(api, null, () => {});
  return (
    <div className="flex flex-col">
      <p className={cn(PANEL.body, "text-[12px] text-muted-foreground")}>
        {t("onboarding.connect.intro")}
      </p>
      <FormError message={form.error} />
      {form.result ? (
        <>
          <NoticePanel
            title={t("onboarding.connect.done", { name: form.result.name })}
          />
          <ProbeChecklist connection={form.result} />
        </>
      ) : (
        <>
          <ConnectionFields form={form} hasCfAccess={false} />
          <div className={PANEL.body}>
            <Button
              size="sm"
              disabled={form.saving}
              onClick={() => void form.save()}
            >
              {form.saving
                ? t("connections.form.saving")
                : t("connections.form.save")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
