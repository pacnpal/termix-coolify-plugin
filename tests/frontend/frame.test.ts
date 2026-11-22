import { describe, expect, it } from "vitest";
import { checkFrameApp } from "@termix-ssh/plugin-sdk/testing";
import * as plugin from "../../src/frontend/index";
import manifest from "../../manifest.json";

describe("sandboxed frame", () => {
  it("registers nothing the shell can't take from a frame", async () => {
    const { problems, registrations } = await checkFrameApp(plugin, {
      manifest: manifest as unknown as Record<string, unknown>,
    });
    expect(problems).toEqual([]);
    expect(registrations.length).toBeGreaterThan(0);
    expect(registrations.map((r) => r.kind)).toContain("companion");
  });

  it("gives the Coolify rail item a badge and opens the activity panel from the rail", async () => {
    const { problems, registrations } = await checkFrameApp(plugin, {
      manifest: manifest as unknown as Record<string, unknown>,
    });
    expect(problems).toEqual([]);
    const rail = registrations
      .filter((r) => r.kind === "railItem")
      .map((r) => r.data as Record<string, unknown>);
    expect(rail).toEqual([
      expect.objectContaining({
        id: "coolify",
        kind: "tab",
        permission: "view",
        badgeKey: expect.any(String),
      }),
      expect.objectContaining({
        id: "coolify-activity",
        kind: "panel",
        permission: "view",
      }),
    ]);
    expect(
      registrations.some(
        (r) =>
          r.kind === "panel" &&
          (r.data as { id?: string }).id === "coolify-activity",
      ),
    ).toBe(true);
  });
});
