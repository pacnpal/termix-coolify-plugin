import { describe, expect, it } from "vitest";
import {
  sameTargets,
  type TagTarget,
} from "../../../src/backend/deployments/by-tag.js";

const target = (uuid: string): TagTarget => ({
  uuid,
  name: uuid,
  kind: "application",
  serverName: null,
});

describe("sameTargets", () => {
  const found = ["app-web-uuid", "svc-n8n-uuid", "App-api-uuid"].map(target);

  it("counts the same uuids in another order as the same set", () => {
    expect(
      sameTargets(["svc-n8n-uuid", "App-api-uuid", "app-web-uuid"], found),
    ).toBe(true);
    expect(
      sameTargets(
        ["app-web-uuid", "App-api-uuid", "svc-n8n-uuid", "app-web-uuid"],
        found,
      ),
    ).toBe(true);
  });

  it("counts a missing, extra or differently cased uuid as a change", () => {
    expect(sameTargets(["app-web-uuid", "svc-n8n-uuid"], found)).toBe(false);
    expect(
      sameTargets(
        ["app-web-uuid", "svc-n8n-uuid", "App-api-uuid", "db-uuid"],
        found,
      ),
    ).toBe(false);
    expect(
      sameTargets(["app-web-uuid", "svc-n8n-uuid", "app-api-uuid"], found),
    ).toBe(false);
  });
});
