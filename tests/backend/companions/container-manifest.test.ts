import { describe, expect, it } from "vitest";
import { manifest } from "../helpers/plugin.js";

const EXACT = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

describe("container companion declarations", () => {
  it("invokes lists only exact ids", () => {
    const invokes = manifest.contributes?.operations?.invokes ?? [];
    for (const id of invokes) expect(id).toMatch(EXACT);
    const uses = manifest.contributes?.uses ?? [];
    for (const id of uses) expect(id).toMatch(EXACT);
    // The frontend reaches File Manager and Tunnels only by exact id.
    expect(uses).toEqual(
      expect.arrayContaining([
        "files.openHost",
        "files.openEditor",
        "tunnels.views",
      ]),
    );
  });

  it("requires the Tunnels and Reverse Proxy services, optionally", () => {
    const requires = (manifest.requires ?? []) as Array<{
      service: string;
      versionRange: string;
      optional?: boolean;
    }>;
    for (const service of ["tunnels.access", "reverse-proxy.endpoints"]) {
      expect(requires.find((r) => r.service === service)).toEqual({
        service,
        versionRange: "~1.0.0",
        optional: true,
      });
    }
    const optional = manifest.optionalDependencies as Record<string, string>;
    expect(optional["file-manager"]).toBe("~1.2.2");
    expect(optional.tunnels).toBe("~1.4.0");
    expect(optional["reverse-proxy"]).toBe("~1.2.1");
  });
});
