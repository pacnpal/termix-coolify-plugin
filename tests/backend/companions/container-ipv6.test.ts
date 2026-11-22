import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHarness } from "../helpers/plugin.js";
import {
  fakeDockerHost,
  startCompanions,
  WEB_RUNNING,
} from "./container-fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

const base = (id: number, uuid: string) =>
  `/connections/${id}/resources/${uuid}`;

/**
 * Answers docker inspect as Docker does: the template's fields filled in
 * for each network, so a template without a field prints nothing for it.
 */
function dockerNetworks(
  h: PluginHarness,
  networks: { IPAddress: string; GlobalIPv6Address: string }[],
) {
  const docker = fakeDockerHost(h, { ps: [WEB_RUNNING] });
  const inner = docker.exec.getMockImplementation()!;
  docker.exec.mockImplementation(async (target, command, ...rest) => {
    const format = /docker inspect -f '([^']*)'/.exec(command)?.[1];
    if (!format) return inner(target, command, ...rest);
    const body =
      /^(?:(?!\{\{range \.NetworkSettings\.Networks\}\}).)*\{\{range \.NetworkSettings\.Networks\}\}(.*)\{\{end\}\}/m.exec(
        format,
      )![1]!;
    const stdout = networks
      .map((n) =>
        body.replace(
          /\{\{\.(IPAddress|GlobalIPv6Address)\}\}/g,
          (_, field: "IPAddress" | "GlobalIPv6Address") => n[field],
        ),
      )
      .join("");
    return { stdout, stderr: "", code: 0, truncated: false, timedOut: false };
  });
}

describe("container addresses over IPv6", () => {
  it("an IPv6-only container is reached at its private IPv6 address", async () => {
    const started = await startCompanions();
    harness = started.harness;
    const { harness: h, connectionId, calls } = started;
    dockerNetworks(h, [{ IPAddress: "", GlobalIPv6Address: "fd00::2" }]);
    const res = await h.request(
      "POST",
      `${base(connectionId, "app-web-uuid")}/tunnel`,
      { port: 3000 },
    );
    expect(res.status).toBe(200);
    // No brackets: Tunnels takes the address as it is.
    expect(calls.forward[0]![1]).toMatchObject({ targetHost: "fd00::2" });
    const web = await h.request(
      "POST",
      `${base(connectionId, "app-web-uuid")}/web-ui`,
      { port: 80 },
    );
    expect(web.status).toBe(200);
    expect(calls.open[0]![0]).toMatchObject({ target: { host: "fd00::2" } });
  });

  it("prefers IPv4 when a network has both", async () => {
    const started = await startCompanions();
    harness = started.harness;
    const { harness: h, connectionId, calls } = started;
    dockerNetworks(h, [
      { IPAddress: "", GlobalIPv6Address: "fd00::9" },
      { IPAddress: "172.18.0.4", GlobalIPv6Address: "fd00::2" },
    ]);
    const res = await h.request(
      "POST",
      `${base(connectionId, "app-web-uuid")}/tunnel`,
      { port: 3000 },
    );
    expect(res.status).toBe(200);
    expect(calls.forward[0]![1]).toMatchObject({ targetHost: "172.18.0.4" });
  });
});
