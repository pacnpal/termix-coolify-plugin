import { describe, expect, it } from "vitest";
import { checkFrameApp } from "@termix-ssh/plugin-sdk/testing";
import * as plugin from "../../src/frontend/index";
import manifest from "../../manifest.json";
import { ACTIVITY_TYPES } from "../../src/shared/activity";

describe("recent activity types", () => {
  it("the coolify tab claims every type the backend records", async () => {
    const { registrations } = await checkFrameApp(plugin, {
      manifest: manifest as unknown as Record<string, unknown>,
    });
    const tab = registrations.find(
      (r) => r.kind === "tab" && (r.data as { id?: string }).id === "coolify",
    );
    expect((tab?.data as { activityTypes?: string[] }).activityTypes).toEqual(
      Object.values(ACTIVITY_TYPES),
    );
  });
});
