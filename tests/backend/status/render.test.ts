import { describe, expect, it } from "vitest";
import { renderStatusPage } from "../../../src/backend/status/render.js";
import en from "../../../locales/en.json";

const P = en.statusPage.public;

const base = {
  title: "Shop status",
  generatedAt: "2026-11-19T10:00:30.000Z",
  updatedAt: "2026-11-19T10:00:00.000Z",
  stale: false,
};

describe("renderStatusPage", () => {
  it("html escapes names", () => {
    const html = renderStatusPage({
      ...base,
      title: `"Shop" <b>&</b> 'co'`,
      items: [
        {
          name: "<img src=x onerror=alert(1)>",
          status: "running",
          lastDeployAt: null,
          lastDeployOk: null,
        },
      ],
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain(
      "&quot;Shop&quot; &lt;b&gt;&amp;&lt;/b&gt; &#39;co&#39;",
    );
  });

  it("no script tags, and a 30 second meta refresh", () => {
    const html = renderStatusPage({
      ...base,
      items: [
        {
          name: "web",
          status: "running",
          lastDeployAt: "2026-11-18T09:03:00.000Z",
          lastDeployOk: true,
        },
      ],
    });
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/(src|href)=["']?https?:/i);
    expect(html).toContain('<meta http-equiv="refresh" content="30">');
    expect(html).toMatch(/^<!doctype html>/i);
  });

  it("shows each status, the last deploy time and result, and Updated", () => {
    const html = renderStatusPage({
      ...base,
      items: [
        {
          name: "web",
          status: "running",
          lastDeployAt: "2026-11-18T09:03:00.000Z",
          lastDeployOk: true,
        },
        {
          name: "api",
          status: "degraded",
          lastDeployAt: "2026-11-17T08:00:00.000Z",
          lastDeployOk: false,
        },
        {
          name: "docs",
          status: "stopped",
          lastDeployAt: null,
          lastDeployOk: null,
        },
      ],
    });
    expect(html).toContain(P.statuses.running);
    expect(html).toContain(P.statuses.degraded);
    expect(html).toContain(P.statuses.stopped);
    expect(html).toContain("2026-11-18 09:03 UTC");
    expect(html).toContain(P.deployOk);
    expect(html).toContain(P.deployFailed);
    expect(html).toContain(P.neverDeployed);
    expect(html).toContain(
      P.updated.replace("{{time}}", "2026-11-19 10:00 UTC"),
    );
    expect(html).not.toContain(P.stale);
  });

  it("stale cache shows the out-of-date banner", () => {
    const html = renderStatusPage({
      ...base,
      stale: true,
      items: [
        {
          name: "web",
          status: "running",
          lastDeployAt: null,
          lastDeployOk: null,
        },
      ],
    });
    expect(html).toContain(P.stale);
  });

  it("shows uptime only when it is given", () => {
    const item = {
      name: "web",
      status: "running",
      lastDeployAt: null,
      lastDeployOk: null,
    };
    const without = renderStatusPage({ ...base, items: [item] });
    expect(without).not.toContain(P.uptime.replace("{{percent}}", ""));
    const withUptime = renderStatusPage({
      ...base,
      items: [{ ...item, uptime: 99.95 }],
    });
    expect(withUptime).toContain(P.uptime.replace("{{percent}}", "99.95"));
  });
});
