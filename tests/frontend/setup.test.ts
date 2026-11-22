import { getConfig } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WAIT_MS } from "../shared/timing.js";

describe("frontend test setup (#105)", () => {
  it("gives findBy and waitFor WAIT_MS, not Testing Library's 1 s", () => {
    expect(getConfig().asyncUtilTimeout).toBe(WAIT_MS);
  });
});
