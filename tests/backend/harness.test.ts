import { describe, expect, it } from "vitest";
import { startPlugin } from "./helpers/plugin.js";

describe("the test harness", () => {
  it("serves on 127.0.0.1 only, the address its requests go to", async () => {
    // Bound to "::", a port another process holds on 127.0.0.1 still binds,
    // and requests to 127.0.0.1 then reach that process instead.
    const h = await startPlugin();
    try {
      expect(h.address?.address).toBe("127.0.0.1");
      expect((await h.request("GET", "/connections")).status).toBe(200);
    } finally {
      await h.close();
    }
  });
});
