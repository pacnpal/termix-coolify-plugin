import { afterEach, describe, expect, it, vi } from "vitest";
import { OTHER, OWNER, type PluginHarness } from "../helpers/plugin.js";
import { grant } from "./fixtures.js";
import {
  fakeDockerHost,
  HOST_ID,
  startCompanions,
  WEB_RUNNING,
  type CompanionCalls,
} from "./container-fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

const PATH = (id: number) => `/connections/${id}/resources/app-web-uuid/tunnel`;
const NAME = `web:${HOST_ID}:coolify-app-web-uuid`;

type Op = { op: "open" | "close"; user: string; port: number };
type Entry = { user: string; port: number } | null;
const open = (user: string, port: number): Op => ({ op: "open", user, port });
const close = (user: string, port: number): Op => ({ op: "close", user, port });

async function run(h: PluginHarness, id: number, o: Op): Promise<number> {
  const res =
    o.op === "open"
      ? await h.request("POST", PATH(id), { port: o.port }, o.user)
      : await h.request("DELETE", `${PATH(id)}/${o.port}`, undefined, o.user);
  return res.status;
}

/** What one call answers and leaves, run on its own. */
function step(entry: Entry, o: Op): { status: number; entry: Entry } {
  if (o.op === "open") {
    if (entry && entry.user !== o.user) return { status: 409, entry };
    return { status: 200, entry: { user: o.user, port: o.port } };
  }
  if (entry && entry.user === o.user && entry.port === o.port) {
    return { status: 200, entry: null };
  }
  return { status: 404, entry };
}

/** Each order the two calls could have run in, one after the other. */
function orders(start: Entry, [x, y]: [Op, Op]) {
  return [
    [x, y],
    [y, x],
  ].map(([first, second]) => {
    const a = step(start, first!);
    const b = step(a.entry, second!);
    const status = first === x ? [a.status, b.status] : [b.status, a.status];
    return { status, entry: b.entry };
  });
}

/**
 * The forward as the registry and Tunnels both see it: Tunnels' open port,
 * and who can close it here on which port (closing it as it is probed).
 * They must agree: Tunnels has it open exactly when one person can close it
 * here on that same port.
 */
async function observe(
  h: PluginHarness,
  id: number,
  calls: CompanionCalls,
): Promise<Entry> {
  const live = calls.live.get(NAME);
  let entry: Entry = null;
  for (const user of [OWNER, OTHER]) {
    for (const port of [3000, 4000]) {
      if ((await run(h, id, close(user, port))) === 200) {
        expect(entry, "closed twice").toBeNull();
        entry = { user, port };
      }
    }
  }
  expect(entry?.port).toBe(live);
  expect(calls.live.size).toBe(0);
  return entry;
}

const A = OWNER;
const B = OTHER;

// Every pair of overlapping calls on one tunnel name, both start orders,
// for the same actor and for different actors.
const CASES: { setup: Op[]; pair: [Op, Op] }[] = [];
for (const y of [A, B]) {
  CASES.push(
    { setup: [], pair: [open(A, 3000), open(y, 4000)] },
    { setup: [open(A, 3000)], pair: [open(y, 4000), close(A, 3000)] },
    { setup: [open(A, 3000)], pair: [close(A, 3000), open(y, 4000)] },
    { setup: [open(A, 3000)], pair: [close(A, 3000), close(y, 3000)] },
    { setup: [open(A, 3000)], pair: [close(A, 3000), open(y, 3000)] },
    { setup: [open(A, 3000)], pair: [open(y, 3000), close(A, 3000)] },
  );
}

/** A small seeded generator, so a failing interleaving can be run again. */
function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const SEEDS = [1, 2, 3, 4, 5, 6];

describe("tunnel registry under overlapping calls", () => {
  it.each(CASES.map((c) => [JSON.stringify(c), c] as const))(
    "%s runs as if one call ran after the other",
    async (_, { setup, pair }) => {
      for (const seed of SEEDS) {
        const rand = random(seed);
        const delay = () => Math.floor(rand() * 30);
        const started = await startCompanions({ delayMs: delay });
        harness = started.harness;
        const { harness: h, connectionId, calls } = started;
        grant(h, connectionId, OTHER, "operate");
        const docker = fakeDockerHost(h, { ps: [WEB_RUNNING] });
        const inner = docker.exec.getMockImplementation()!;
        docker.exec.mockImplementation(async (...args) => {
          await new Promise((r) => setTimeout(r, delay()));
          return inner(...args);
        });
        const get = h.mock.ctx.services.get.bind(h.mock.ctx.services);
        vi.spyOn(h.mock.ctx.services, "get").mockImplementation(
          async (name: string) => {
            await new Promise((r) => setTimeout(r, delay()));
            return get(name);
          },
        );
        let start: Entry = null;
        for (const o of setup) {
          expect(await run(h, connectionId, o)).toBe(200);
          start = step(start, o).entry;
        }
        const status = await Promise.all(
          pair.map((o) => run(h, connectionId, o)),
        );
        const entry = await observe(h, connectionId, calls);
        expect(
          orders(start, pair),
          `seed ${seed}: answered ${status}, left ${JSON.stringify(entry)}`,
        ).toContainEqual({ status, entry });
        await h.close();
        harness = null;
        vi.restoreAllMocks();
      }
    },
  );
});
