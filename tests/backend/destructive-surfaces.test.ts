import { describe, expect, it } from "vitest";
import manifest from "../../manifest.json";

describe("destructive actions", () => {
  it("are never offered to the assistant or Termix's MCP", () => {
    const offered = manifest.contributes.operations.actions
      .filter((a) => a.risk === "destructive")
      .filter((a) => {
        const s = (a as { surfaces?: { assistant?: boolean; mcp?: boolean } })
          .surfaces;
        return s?.assistant === true || s?.mcp === true;
      })
      .map((a) => a.id);
    expect(offered).toEqual([]);
  });
});
