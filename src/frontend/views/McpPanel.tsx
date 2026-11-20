import { useEffect, useState } from "react";
import { Bot, Copy } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  LoadingState,
  NoticePanel,
  PANEL,
  SectionCard,
  copyToClipboard,
} from "@termix-ssh/plugin-sdk/ui";
import type { Api, McpInfo } from "../api";

/**
 * The client config for an MCP client. Built here from the endpoint and the
 * placeholder, so no key can ever reach the page.
 */
export function mcpSnippet(endpoint: string, placeholder: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "termix-coolify": {
          url: endpoint,
          headers: { Authorization: `Bearer ${placeholder}` },
        },
      },
    },
    null,
    2,
  );
}

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => void copyToClipboard(value).then((ok) => setCopied(ok))}
    >
      <Copy className="size-3.5" />
      {copied ? t("connections.mcp.copied") : t("connections.mcp.copy")}
    </Button>
  );
}

/** "Use with an MCP client": the endpoint, a config snippet and the setup steps. */
export function McpPanel({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .getMcpInfo()
      .then((found) => {
        if (!live) return;
        setInfo(found);
        setFailed(found === null);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [api]);

  const snippet = info
    ? mcpSnippet(info.endpoint, t("connections.mcp.keyPlaceholder"))
    : "";

  return (
    <SectionCard
      title={t("connections.mcp.title")}
      icon={<Bot className="size-4" />}
    >
      <div className={`${PANEL.section} flex flex-col gap-3 text-[12px]`}>
        <p className="text-muted-foreground">
          {t("connections.mcp.description")}
        </p>
        {failed ? (
          <NoticePanel
            tone="destructive"
            title={t("connections.mcp.loadFailed")}
          />
        ) : !info ? (
          <LoadingState compact label={t("connections.mcp.loading")} />
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <span className="font-medium">
                {t("connections.mcp.endpoint")}
              </span>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate border border-border bg-background px-2 py-1">
                  {info.endpoint}
                </code>
                <CopyButton value={info.endpoint} />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  {t("connections.mcp.config")}
                </span>
                <CopyButton value={snippet} />
              </div>
              <pre
                data-testid="mcp-snippet"
                className="overflow-x-auto border border-border bg-background p-2 text-[11px]"
              >
                {snippet}
              </pre>
            </div>
          </>
        )}
        <div className="flex flex-col gap-1">
          <span className="font-medium">
            {t("connections.mcp.steps.title")}
          </span>
          <ol className="list-decimal pl-5 text-muted-foreground">
            <li>{t("connections.mcp.steps.key")}</li>
            <li>{t("connections.mcp.steps.paste")}</li>
            <li>{t("connections.mcp.steps.changes")}</li>
          </ol>
        </div>
      </div>
    </SectionCard>
  );
}
