import { EventEmitter } from "node:events";
import { REDACTED_VALUE } from "@termix-ssh/plugin-sdk/operations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectKeyTailMasked, KEY_TAIL } from "../helpers/key-tail.js";
import { growth, LINEAR_GROWTH } from "../../shared/linear-cost.js";
import { OTHER, OWNER, type PluginHarness } from "../helpers/plugin.js";
import { resourceLists } from "../helpers/resources.js";
import {
  fakeDocker,
  HOST_ID,
  LOG_SOURCES,
  serveKeyTail,
  setSensitive,
  startShell,
} from "./fixtures.js";
import { RECHECK_MS } from "../../../src/backend/containers/sockets.js";
import {
  lineSplitter,
  MAX_LINE,
  redactLog,
} from "../../../src/backend/containers/logs.js";
import { eventually, HEAVY_TEST_MS } from "../../shared/timing.js";

/** A deterministic secret of `n` characters from `alphabet`, no 6-gram repeating much. */
function secretOf(
  n: number,
  alphabet = "abcdefghijklmnopqrstuvwxyz0123456789",
) {
  let seed = 12345;
  let out = "";
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out += alphabet[seed % alphabet.length];
  }
  return out;
}

/** Streams `text` through a follow's splitter in 4 KiB chunks. */
function streamed(text: string): string[] {
  const sent: string[] = [];
  const split = lineSplitter([], (lines) => sent.push(...lines));
  for (let i = 0; i < text.length; i += 4096) {
    split.data(Buffer.from(text.slice(i, i + 4096)));
  }
  split.end();
  return sent;
}

/** Any 6-character slice of `secret` in any piece. */
function leakedSlice(pieces: string[], secret: string): string | null {
  const grams = new Set<string>();
  for (let i = 0; i + 6 <= secret.length; i += 1)
    grams.add(secret.slice(i, i + 6));
  for (const piece of pieces) {
    for (let i = 0; i + 6 <= piece.length; i += 1) {
      const gram = piece.slice(i, i + 6);
      if (grams.has(gram)) return gram;
    }
  }
  return null;
}

/** A seeded PRNG (mulberry32): the same cases every run. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("long-line redaction property", () => {
  // Secrets use only [A-Z0-9] (and @ in URL passwords); filler, keys and the
  // mask are lower case, so any run of six of them in the output is a leak.
  const LEAK = /[A-Z0-9@]{6}/;
  const CASES = 500;
  // The cases are seeded, so the work is the same on every run (about 2 s
  // alone). Only the wall time grows with machine load, and Vitest's default
  // 5 s timeout is a wall-clock budget: a busy machine failed the test on it,
  // not on a leak. The timeout leaves a wide margin instead; the cases and
  // the leak check are unchanged.
  const TIMEOUT_MS = 120_000;

  it(
    "never emits six characters of a secret, whatever the shape, length or chunking",
    () => {
      const rand = prng(20261120);
      const int = (lo: number, hi: number) =>
        lo + Math.floor(rand() * (hi - lo + 1));
      const pick = <T>(list: readonly T[]) => list[int(0, list.length - 1)];
      // Secrets are slices of one seeded pool at random offsets: building
      // each character apart cost more than the redaction under test.
      let pool = "";
      for (let i = 0; i < 256 * 1024; i += 1) {
        pool += "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[int(0, 35)];
      }
      const upper = (n: number) => {
        const at = int(0, pool.length - n);
        return pool.slice(at, at + n);
      };
      const words = [
        "lorem",
        "ipsum",
        "dolor",
        "sit",
        "amet",
        "x.y",
        "a-b",
        "q&r",
        "s/t",
      ];
      let fillerPool = "";
      while (fillerPool.length < 64 * 1024) fillerPool += pick(words) + " ";
      const filler = (n: number) => {
        const at = int(0, fillerPool.length - n);
        return fillerPool.slice(at, at + n);
      };
      const withAt = (n: number) => {
        const s = upper(n);
        const at = int(1, n - 2);
        return s.slice(0, at) + "@" + s.slice(at + 1);
      };
      const shapes: ((n: number) => string)[] = [
        (n) => `postgres://app:${upper(n)}@db/app`,
        (n) => `postgres://app:${withAt(n)}@db/app`,
        (n) => `{"password": "${upper(n)}"}`,
        (n) => `secret='${upper(n)}'`,
        (n) => `token=${upper(n)}`,
        (n) => `db_password=${upper(n)}`,
        (n) => `Authorization: Basic ${upper(n)}`,
        (n) => `proxy-authorization: Bearer ${upper(n)}`,
        (n) =>
          `"-----BEGIN RSA PRIVATE KEY-----\\n${upper(n)}\\n-----END RSA PRIVATE KEY-----"`,
      ];
      // The key markers' own words are upper case: they aren't secrets. A piece
      // cut inside one starts or ends with a part of "PRIVATE".
      const leak = (text: string) =>
        LEAK.exec(
          text
            .replace(/^[PRIVATE]{1,7}(?= KEY-----)/, "")
            .replace(/P(?:R(?:I(?:V(?:A(?:T(?:E)?)?)?)?)?)?$/, "")
            .replaceAll("PRIVATE", ""),
        );
      const failures: number[] = [];
      const header = "-----BEGIN RSA PRIVATE KEY-----";
      for (let c = 0; c < CASES; c += 1) {
        const token = upper(int(1024, 30 * 1024));
        const access = upper(int(1024, 4096));
        const target = int(1, 5) * MAX_LINE;
        let line =
          rand() < 0.15 ? `password: ${upper(int(1024, 30 * 1024))} ` : "";
        if (!line && rand() < 0.25) {
          // A key header across the first 16 KiB piece boundary, at any offset.
          const off = int(0, header.length);
          line = `${filler(MAX_LINE - off)}${header}\\n${upper(int(64, 4096))}\\n-----END RSA PRIVATE KEY----- `;
        }
        while (line.length < target) {
          const r = rand();
          line += filler(int(1, 6000)) + " ";
          if (r < 0.15) line += token + " ";
          else if (r < 0.25) line += access + " ";
          else line += pick(shapes)(int(1024, 30 * 1024)) + " ";
        }
        // The whole line, redacted at once, shows no secret: the shapes are
        // ones redactLog masks.
        const whole = redactLog(line, [token, access]);
        const wholeLeak = leak(whole);
        expect(
          wholeLeak &&
            whole.slice(
              Math.max(0, wholeLeak.index - 60),
              wholeLeak.index + 20,
            ),
          `case ${c} whole`,
        ).toBeNull();
        const sent: string[] = [];
        const split = lineSplitter([token, access], (l) => sent.push(...l));
        for (let i = 0; i < line.length;) {
          const size = int(1, 8192);
          split.data(Buffer.from(line.slice(i, i + size)));
          i += size;
        }
        split.data(Buffer.from("\n"));
        split.end();
        if (sent.some((piece) => leak(piece) || piece.length > MAX_LINE)) {
          failures.push(c);
        }
      }
      expect(failures, `${failures.length} of ${CASES} cases leaked`).toEqual(
        [],
      );
    },
    TIMEOUT_MS,
  );
});

describe("long-line cuts with an open secret", () => {
  it("Codex's repro: a URL password with an @ in it", () => {
    const sent = streamed(
      "postgres://app:abc@" + "x".repeat(20000) + "@db/app",
    );
    expect(sent.join("")).not.toContain("xxxxxx");
    expect(sent.join("")).not.toContain("abc@");
  });

  it("Codex's repro: a URL password longer than the window", () => {
    const sent = streamed("postgres://app:" + "x".repeat(20000) + "@db/app");
    expect(sent.join("")).not.toContain("xxxxxx");
    expect(sent.join("")).toContain("[redacted]");
  });

  const filler = (n: number) =>
    "lorem ipsum ".repeat(Math.ceil(n / 12)).slice(0, n);
  const secret = secretOf(6000);
  for (const [name, line] of [
    ["a quoted password value", `{"password": "${secret}"} `],
    ["a token= value", `token=${secret} `],
    ["an Authorization: Basic credential", `Authorization: Basic ${secret} `],
    ["a URL with a password", `postgres://app:${secret}@db/app `],
  ] as const) {
    it(`masks ${name} longer than 4 KiB across the cut`, () => {
      const sent = streamed(filler(14000) + line + filler(30000));
      expect(leakedSlice(sent, secret), name).toBeNull();
      for (const piece of sent)
        expect(piece.length).toBeLessThanOrEqual(MAX_LINE);
    });
  }
});

describe("private key blocks", () => {
  const pem = (kind: string, body: string, sep: string) =>
    `-----BEGIN ${kind}PRIVATE KEY-----${sep}${body}${sep}-----END ${kind}PRIVATE KEY-----`;

  it("masks every block on one line, as a JSON array of escaped PEMs", () => {
    const line = JSON.stringify([
      pem("RSA ", "fake-key-one-body", "\n"),
      pem("", "fake-key-two-body", "\n"),
      pem("OPENSSH ", "fake-key-three-body", "\n"),
    ]);
    expect(line).toContain("\\n");
    for (const out of [redactLog(line, []), streamed(line).join("\n")]) {
      expect(out).not.toMatch(/fake-key-\w+-body/);
      expect(out).toContain("-----END OPENSSH PRIVATE KEY-----");
    }
  });

  it("masks real multi-line blocks, in a snapshot and streamed", () => {
    const text = [
      "before",
      pem("RSA ", "fake-multi-a\nfake-multi-b", "\n"),
      "between",
      pem("EC ", "fake-multi-c", "\n"),
      "after",
      "",
    ].join("\n");
    for (const out of [redactLog(text, []), streamed(text).join("\n")]) {
      expect(out).not.toContain("fake-multi");
      expect(out).toContain("before");
      expect(out).toContain("between");
      expect(out).toContain("after");
    }
  });

  it("masks an unterminated block to the end of the stream", () => {
    const text = `ok\n-----BEGIN PRIVATE KEY-----\nfake-open-a\nfake-open-b\n`;
    for (const out of [redactLog(text, []), streamed(text).join("\n")]) {
      expect(out).toContain("ok");
      expect(out).toContain("-----BEGIN PRIVATE KEY-----");
      expect(out).not.toContain("fake-open");
    }
  });

  it("a BEGIN header split at a 16 KiB piece or cut boundary still masks", () => {
    const header = "-----BEGIN RSA PRIVATE KEY-----";
    const body = "fake-split-body-".repeat(40);
    // The header straddles MAX_LINE (a piece) at every offset, in a complete
    // line and in a partial one still being cut (no newline until the end).
    for (let off = 0; off <= header.length; off += 1) {
      const pad = "p".repeat(MAX_LINE - off);
      const tail = `${body}\\n-----END RSA PRIVATE KEY----- ${"q".repeat(40000)}`;
      for (const text of [
        `${pad}${header}${tail}\n`,
        `${pad}${header}${tail}`,
        `${pad}${header}\n${body}\n-----END RSA PRIVATE KEY-----\n`,
      ]) {
        const out = streamed(text).join("\n");
        expect(out, `offset ${off}`).not.toContain("fake-split-body");
        const sent: string[] = [];
        const split = lineSplitter([], (l) => sent.push(...l));
        for (let i = 0; i < text.length; i += MAX_LINE - off + 1) {
          split.data(Buffer.from(text.slice(i, i + MAX_LINE - off + 1)));
        }
        split.end();
        expect(sent.join("\n"), `chunked ${off}`).not.toContain(
          "fake-split-body",
        );
      }
    }
  });

  it("masks a key body streamed in tiny chunks", () => {
    const text = `${pem("RSA ", "fake-chunked-body\n".repeat(50), "\n")}\nnext\n`;
    const sent: string[] = [];
    const split = lineSplitter([], (lines) => sent.push(...lines));
    for (let i = 0; i < text.length; i += 7) {
      split.data(Buffer.from(text.slice(i, i + 7)));
    }
    split.end();
    expect(sent.join("\n")).not.toContain("fake-chunked");
    expect(sent).toContain("next");
  });
});

describe("a snapshot or stream that starts inside a private key", () => {
  // A tail cut (docker logs --tail, Coolify's ?lines=) that falls inside a
  // key: its body and END arrive with no BEGIN before them.
  const END = "-----END RSA PRIVATE KEY-----";
  // Body lines as a PEM has them: 64 base64 characters, the last shorter.
  const BODY = [`FAKETAILBODY${"A".repeat(52)}`, "FAKETAILBODYLAST="];
  const tail = [...BODY, END, "after the key", "last line", ""].join("\n");

  /** Lines a fresh splitter emits for `chunks`, fed in order. */
  function follow(chunks: string[]): string[] {
    const sent: string[] = [];
    const split = lineSplitter([], (lines) => sent.push(...lines));
    for (const chunk of chunks) split.data(Buffer.from(chunk));
    split.end();
    return sent;
  }

  it("a snapshot masks from its start through the END line, and keeps what follows", () => {
    const out = redactLog(tail, []);
    expect(out).not.toContain("FAKETAILBODY");
    expect(out).toBe(`${REDACTED_VALUE}${END}\nafter the key\nlast line\n`);
  });

  it("an END with no key around it masks only up to and including itself", () => {
    const text = [
      "plain before",
      END,
      "plain after",
      "-----BEGIN PRIVATE KEY-----",
      "fake-later-body",
      "-----END PRIVATE KEY-----",
      "last",
      "",
    ].join("\n");
    expect(redactLog(text, [])).toBe(
      [
        `${REDACTED_VALUE}${END}`,
        "plain after",
        `-----BEGIN PRIVATE KEY-----${REDACTED_VALUE}-----END PRIVATE KEY-----`,
        "last",
        "",
      ].join("\n"),
    );
    // Mid-line, too: what follows the marker on its line stays.
    expect(redactLog(`a fake-mid ${END} b\nc`, [])).toBe(
      `${REDACTED_VALUE}${END} b\nc`,
    );
  });

  it("an END closing an open key of its own kind is not a tail", () => {
    const text = `ok\n-----BEGIN RSA PRIVATE KEY-----\nfake-whole\n${END}\nafter\n`;
    expect(redactLog(text, [])).toBe(
      `ok\n-----BEGIN RSA PRIVATE KEY-----${REDACTED_VALUE}${END}\nafter\n`,
    );
  });

  it("a follow whose first lines are key body and END shows none of them", () => {
    const lines = tail.split("\n");
    for (const [name, chunks] of [
      ["one chunk", [tail]],
      [
        "a chunk per line",
        lines.map((l, i) => (i < lines.length - 1 ? `${l}\n` : l)),
      ],
      ["the END split across chunks", [tail.slice(0, 50), tail.slice(50)]],
      ["tiny chunks", tail.match(/[\s\S]{1,5}/g)!],
    ] as const) {
      const sent = follow([...chunks]);
      expect(sent.join("\n"), name).not.toContain("FAKETAILBODY");
      expect(sent, name).toEqual([
        `${REDACTED_VALUE}${END}`,
        "after the key",
        "last line",
      ]);
    }
  });

  it("a follow of PEM-wide body lines, a short last line and END, one per chunk, shows none", () => {
    const wide = "A".repeat(64);
    const stamp = "2026-11-22T10:00:00.123456789Z ";
    for (const prefix of ["", stamp]) {
      const sent = follow([
        `${prefix}${wide}\n`,
        `${prefix}${wide}\n`,
        `${prefix}FAKESHORT=\n`,
        `${prefix}${END}\n`,
        `${prefix}after\n`,
      ]);
      expect(sent.join("\n"), prefix).not.toMatch(/AAAAAA|FAKESHORT/);
      expect(sent.at(-1), prefix).toBe(`${prefix}after`);
    }
  });

  it("a follow that starts with an ordinary line sends it at once", () => {
    const sent: string[] = [];
    const split = lineSplitter([], (lines) => sent.push(...lines));
    split.data(Buffer.from("Server listening on 3000\n"));
    expect(sent).toEqual(["Server listening on 3000"]);
  });

  it("an END later in a follow masks only its own line up to itself", () => {
    expect(follow(["ok line\n", `fake-mid ${END} tail\nlater\n`])).toEqual([
      "ok line",
      `${REDACTED_VALUE}${END} tail`,
      "later",
    ]);
  });
});

describe("redactLog", () => {
  const masked = (text: string) => redactLog(text, []);

  it("masks the whole quoted value, spaces, commas and escaped quotes included", () => {
    for (const [line, leaks] of [
      ['{"password": "alpha beta gamma"}', ["alpha", "beta", "gamma"]],
      ['{"password": "correct horse battery staple"}', ["horse", "staple"]],
      ['{"api_key": " leading-secret"}', ["leading-secret"]],
      ['{"token": "ab\\"cd, ef; gh"}', ["ab", "cd", "ef", "gh"]],
      ["secret='one two'", ["one", "two"]],
    ] as const) {
      const out = masked(line);
      for (const leak of leaks) expect(out, line).not.toContain(leak);
      expect(out, line).toContain("[redacted]");
    }
    // The rest of the JSON stays.
    expect(masked('{"password": "a b", "user": "bob"}')).toContain(
      '"user": "bob"',
    );
  });

  it("masks every secret on a line, unquoted, quoted and next to a URL", () => {
    for (const [line, leaks, kept] of [
      [
        "password=alpha token=bravo api_key=charlie",
        ["alpha", "bravo", "charlie"],
        [],
      ],
      [
        'password=alpha secret="bravo two" token=charlie&api_key=delta user=bob',
        ["alpha", "bravo", "two", "charlie", "delta"],
        ["user=bob"],
      ],
      [
        "db=postgres://app:fake-url-pass@db/app token=bravo done",
        ["fake-url-pass", "bravo"],
        ["postgres://app:", "done"],
      ],
    ] as const) {
      const out = masked(line);
      for (const leak of leaks) expect(out, line).not.toContain(leak);
      for (const keep of kept) expect(out, line).toContain(keep);
      // A fixed point: redacting again changes nothing.
      expect(masked(out)).toBe(out);
    }
  });

  it("masks Authorization and Proxy-Authorization credentials of any length", () => {
    for (const line of [
      "Authorization: Basic dTpw",
      "Authorization: Bearer abc",
      "proxy-authorization: Basic dTpw",
      '{"Authorization": "Bearer abc"}',
    ]) {
      const out = masked(line);
      expect(out, line).toContain("[redacted]");
      expect(out, line).not.toMatch(/dTpw|abc/);
    }
  });

  // Fixed work: growth() samples each size for 25 clock steps, a few tenths
  // of a second of CPU; an explicit timeout keeps a busy machine from failing
  // it on Vitest's 5 s (#105).
  it(
    "redacts one MAX_LINE line in linear time, adversarial ones too",
    () => {
      // Each shape at `scale` of MAX_LINE.
      const shapes = (scale: number) => {
        const size = MAX_LINE * scale;
        return [
          // Scheme-like letter runs, dotted words, a secret field every so often.
          ("abcdefghij".repeat(40) + " a-b.c-d.e-f " + "password=x ").repeat(
            Math.ceil(size / 470),
          ),
          "a-".repeat(size / 2),
          "q".repeat(size),
          'password="' + "\\".repeat(size),
          'password="' + '\\"'.repeat(size / 2),
          "x://" + "y".repeat(size),
          "&" + "token".repeat(size / 5),
        ].map((s) => s.slice(0, size));
      };
      for (const [n, line] of shapes(1).entries()) {
        // Growth, not milliseconds: load can't fail it (#105).
        const grew = growth((scale) => {
          const input = shapes(scale)[n];
          return () => redactLog(input, [TOKEN]);
        });
        expect(grew, line.slice(0, 20)).toBeLessThan(LINEAR_GROWTH);
      }
    },
    HEAVY_TEST_MS,
  );

  // Fixed work: growth() samples each size for 25 clock steps, a few tenths
  // of a second of CPU; an explicit timeout keeps a busy machine from failing
  // it on Vitest's 5 s (#105).
  it(
    "streams 8 MB with no newline through the follow splitter in linear time, leaking nothing",
    () => {
      const block =
        "z".repeat(3000) +
        ` ${TOKEN} ` +
        "word-".repeat(400) +
        " password=fake-perf-pass " +
        "abcdefghij".repeat(300);
      const stream = (text: string) => {
        const sent: string[] = [];
        const split = lineSplitter([TOKEN], (lines) => sent.push(...lines));
        for (let i = 0; i < text.length; i += 64 * 1024) {
          split.data(Buffer.from(text.slice(i, i + 64 * 1024)));
        }
        split.end();
        return sent;
      };
      const sized = (scale: number) =>
        block.repeat(Math.ceil((8 * 1024 * 1024 * scale) / block.length));
      // Growth, not milliseconds: load can't fail it (#105). 8 MB, not 2: at
      // 2 MB a planted quadratic splitter grew only 29 times against the bound
      // of 24; the longer stream gives its quadratic part room to show.
      const grew = growth((scale) => {
        const text = sized(scale);
        return () => stream(text);
      });
      expect(grew).toBeLessThan(LINEAR_GROWTH);
      const sent = stream(sized(1));
      expect(sent.length).toBeGreaterThan(100);
      for (const piece of sent) {
        expect(piece.length).toBeLessThanOrEqual(MAX_LINE);
        for (const leak of [
          TOKEN,
          TOKEN.slice(0, 6),
          TOKEN.slice(-6),
          "fake-perf",
          "perf-pass",
        ]) {
          expect(piece).not.toContain(leak);
        }
      }
    },
    HEAVY_TEST_MS,
  );

  it("masks unquoted env values to the end of the token and YAML values to the end of the line", () => {
    const env = masked("DB_PASSWORD=abc;def,ghi user=bob");
    for (const leak of ["abc", "def", "ghi"]) expect(env).not.toContain(leak);
    expect(env).toContain("user=bob");
    const yaml = masked("  password: alpha beta gamma");
    for (const leak of ["alpha", "beta", "gamma"]) {
      expect(yaml).not.toContain(leak);
    }
    expect(masked("export API_KEY= spaced-out")).not.toContain("spaced-out");
  });
});

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

async function start(options: Parameters<typeof startShell>[0] = {}) {
  const started = await startShell(options);
  harness = started.harness;
  return started;
}

const logsPath = (id: number, uuid: string, query = "") =>
  `/connections/${id}/resources/${uuid}/logs${query}`;

const WEB_RUNNING: [RegExp, string] = [
  /applicationUuid=app-web-uuid/,
  "web-abc|running||\n",
];

function logCalls(fake: { calls: { path: string; url: string }[] }) {
  return fake.calls.filter((c) => c.path.endsWith("/logs"));
}

/** The connection's token (startShell's), echoed by a careless app. */
const TOKEN = "fake-token-shell-test";
const LEAKY = [
  `auth Bearer ${TOKEN}`,
  "db postgres://app:fake-db-pass@db:5432/app",
  "GET /hook?token=fake-query-token&x=1",
  "DB_PASSWORD=fake-env-pass",
  '{"api_key": "fake-json-key"}',
  "plain line",
  "",
].join("\n");

function expectMasked(text: string) {
  for (const secret of [
    TOKEN,
    "fake-db-pass",
    "fake-query-token",
    "fake-env-pass",
    "fake-json-key",
  ]) {
    expect(text).not.toContain(secret);
  }
  expect(text).toContain("plain line");
  expect(text).toContain("postgres://app:");
}

/** Points the connection at another token, as an owner's edit would. */
function repoint(h: PluginHarness) {
  h.db.sqlite
    .prepare("UPDATE p_coolify_connections SET token_sealed = ?")
    .run("sealed:another-instance");
}

describe("logs snapshot route", () => {
  it("with read:sensitive logs come from Coolify labelled coolify", async () => {
    const { harness: h, fake, connectionId } = await start();
    setSensitive(h, connectionId, true);
    fake.set("GET /applications/app-web-uuid/logs", {
      json: { logs: "one\ntwo\n" },
    });
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const res = await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ source: "coolify", text: "one\ntwo\n" });
    const [call] = logCalls(fake).slice(-1);
    expect(new URL(call.url).searchParams.get("lines")).toBe("100");
    expect(docker.commands).toEqual([]);
  });

  it("without read:sensitive logs come over SSH labelled ssh", async () => {
    const { harness: h, fake, connectionId } = await start();
    setSensitive(h, connectionId, false);
    const before = logCalls(fake).length;
    const docker = fakeDocker(h, {
      ps: [WEB_RUNNING],
      logs: "from docker\n",
    });
    const res = await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      source: "ssh",
      text: "from docker\n",
      container: "web-abc",
    });
    expect(docker.commands).toContain(
      "docker logs --tail '100' 'web-abc' 2>&1",
    );
    expect(docker.exec.mock.calls.every(([host]) => host === HOST_ID)).toBe(
      true,
    );
    expect(logCalls(fake).length).toBe(before);
  });

  it("a view grant reads no logs, through Coolify or over SSH", async () => {
    const { harness: h, fake, connectionId } = await start();
    for (const sensitive of [true, false]) {
      setSensitive(h, connectionId, sensitive);
      h.db.sqlite
        .prepare(
          "INSERT OR REPLACE INTO p_coolify_grants (connection_id, user_id, level) VALUES (?, ?, ?)",
        )
        .run(connectionId, OTHER, "view");
      const before = logCalls(fake).length;
      const docker = fakeDocker(h, { ps: [WEB_RUNNING], logs: "x\n" });
      const res = await h.request(
        "GET",
        logsPath(connectionId, "app-web-uuid"),
        undefined,
        OTHER,
      );
      expect(res.status).toBe(403);
      expect(res.body.cause).toBe("forbidden");
      expect(docker.commands).toEqual([]);
      expect(logCalls(fake).length).toBe(before);
    }
  });

  it("masks the token, URL credentials and secret fields in a Coolify snapshot", async () => {
    const { harness: h, fake, connectionId } = await start();
    setSensitive(h, connectionId, true);
    fake.set("GET /applications/app-web-uuid/logs", { json: { logs: LEAKY } });
    const res = await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("coolify");
    expectMasked(res.body.text);
  });

  it("masks the token, URL credentials and secret fields in an SSH snapshot", async () => {
    const { harness: h, connectionId } = await start();
    setSensitive(h, connectionId, false);
    fakeDocker(h, { ps: [WEB_RUNNING], logs: LEAKY });
    const res = await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("ssh");
    expectMasked(res.body.text);
  });

  it.each(LOG_SOURCES)(
    "a snapshot from %s that starts inside a private key shows none of its body",
    async (source, sensitive) => {
      const started = await start();
      serveKeyTail(started, sensitive);
      const res = await started.harness.request(
        "GET",
        logsPath(started.connectionId, "app-web-uuid"),
      );
      expect(res.status).toBe(200);
      expect(res.body.source).toBe(source);
      expectKeyTailMasked(res.body.text);
    },
  );

  it("a target change before Coolify's logs call reads nothing", async () => {
    const { harness: h, fake, connectionId } = await start();
    setSensitive(h, connectionId, true);
    const list = resourceLists()["GET /applications"] as { json: unknown };
    fake.set("GET /applications", () => {
      // The owner points the connection at another token mid-way.
      repoint(h);
      return Response.json(list.json);
    });
    const before = logCalls(fake).length;
    const res = await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("target-changed");
    expect(logCalls(fake).length).toBe(before);
  });

  it("a target change before docker logs runs no docker logs", async () => {
    const { harness: h, connectionId } = await start();
    setSensitive(h, connectionId, false);
    const docker = fakeDocker(h, { ps: [WEB_RUNNING], logs: "x\n" });
    const real = docker.exec.getMockImplementation()!;
    docker.exec.mockImplementation(async (...args) => {
      if (/docker ps /.test(args[1])) repoint(h);
      return real(...args);
    });
    const res = await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("target-changed");
    expect(docker.commands.some((c) => /docker logs /.test(c))).toBe(false);
  });

  it("falls back to SSH when Coolify refuses the token's ability", async () => {
    const { harness: h, fake, connectionId } = await start();
    setSensitive(h, connectionId, true);
    fake.set("GET /applications/app-web-uuid/logs", {
      status: 403,
      json: { message: "Missing ability." },
    });
    fakeDocker(h, { ps: [WEB_RUNNING], logs: "fallback\n" });
    const res = await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: "ssh", text: "fallback\n" });
  });

  it("lines are capped at 10000", async () => {
    const { harness: h, fake, connectionId } = await start();
    setSensitive(h, connectionId, true);
    const many = Array.from({ length: 10_005 }, (_, i) => `l${i}`).join("\n");
    fake.set("GET /applications/app-web-uuid/logs", { json: { logs: many } });
    const viaCoolify = await h.request(
      "GET",
      logsPath(connectionId, "app-web-uuid", "?lines=50000"),
    );
    expect(viaCoolify.status).toBe(200);
    const [call] = logCalls(fake).slice(-1);
    expect(new URL(call.url).searchParams.get("lines")).toBe("10000");
    const coolifyLines = viaCoolify.body.text.split("\n");
    expect(coolifyLines).toHaveLength(10_000);
    expect(coolifyLines.at(-1)).toBe("l10004");

    setSensitive(h, connectionId, false);
    const docker = fakeDocker(h, { ps: [WEB_RUNNING], logs: many });
    const viaSsh = await h.request(
      "GET",
      logsPath(connectionId, "app-web-uuid", "?lines=50000"),
    );
    expect(viaSsh.status).toBe(200);
    expect(docker.commands).toContain(
      "docker logs --tail '10000' 'web-abc' 2>&1",
    );
    expect(viaSsh.body.text.split("\n")).toHaveLength(10_000);
  });

  it("asks for timestamps from Coolify and from docker", async () => {
    const { harness: h, fake, connectionId } = await start();
    setSensitive(h, connectionId, true);
    await h.request(
      "GET",
      logsPath(connectionId, "app-web-uuid", "?lines=5&timestamps=true"),
    );
    const [call] = logCalls(fake).slice(-1);
    const query = new URL(call.url).searchParams;
    expect(query.get("lines")).toBe("5");
    expect(query.get("show_timestamps")).toBe("true");

    setSensitive(h, connectionId, false);
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    await h.request(
      "GET",
      logsPath(connectionId, "app-web-uuid", "?lines=5&timestamps=true"),
    );
    expect(docker.commands).toContain(
      "docker logs --tail '5' --timestamps 'web-abc' 2>&1",
    );
  });

  it("refuses a line count or flag that isn't one", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    for (const query of ["?lines=abc", "?lines=0", "?timestamps=maybe"]) {
      const res = await h.request(
        "GET",
        logsPath(connectionId, "app-web-uuid", query),
      );
      expect(res.status, query).toBe(400);
      expect(res.body.cause).toBe("invalid-input");
    }
    expect(docker.commands).toEqual([]);
  });

  it("no linked host answers not-linked for SSH logs", async () => {
    const { harness: h, connectionId } = await start();
    setSensitive(h, connectionId, false);
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    // app-api-uuid runs on srv-edge-uuid, which has no Linked host.
    const res = await h.request("GET", logsPath(connectionId, "app-api-uuid"));
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("not-linked");
    expect(res.body.error).toMatch(/Link this server first/);
    expect(docker.commands).toEqual([]);
  });

  it("SSH logs need the actor's own connect access to the Linked host", async () => {
    const { harness: h, connectionId } = await start();
    setSensitive(h, connectionId, false);
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const access = vi
      .spyOn(h.mock.ctx.hosts, "checkAccess")
      .mockResolvedValue({ hasAccess: false, isOwner: false, isShared: false });
    const res = await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(res.status).toBe(403);
    expect(res.body.cause).toBe("no-host-access");
    expect(access).toHaveBeenCalledWith(HOST_ID, "connect");
    expect(docker.commands).toEqual([]);
  });

  it("several containers answer choices, and a chosen one is read", async () => {
    const { harness: h, connectionId } = await start();
    setSensitive(h, connectionId, false);
    const docker = fakeDocker(h, {
      ps: [
        [
          /serviceUuid=svc-n8n-uuid/,
          "n8n-a|running|part-n8n-uuid|n8n\npg-a|exited|part-postgres-uuid|postgresql\n",
        ],
      ],
      logs: "pg says hi\n",
    });
    const several = await h.request(
      "GET",
      logsPath(connectionId, "svc-n8n-uuid"),
    );
    expect(several.status).toBe(300);
    expect(several.body.choices.map((c: { name: string }) => c.name)).toEqual([
      "n8n-a",
      "pg-a",
    ]);
    // A stopped container still has logs.
    const chosen = await h.request(
      "GET",
      logsPath(connectionId, "svc-n8n-uuid", "?container=pg-a"),
    );
    expect(chosen.status).toBe(200);
    expect(chosen.body).toEqual({
      source: "ssh",
      text: "pg says hi\n",
      container: "pg-a",
    });
    expect(docker.commands).toContain("docker logs --tail '100' 'pg-a' 2>&1");
  });

  it("a container name with ; or $( is refused before any SSH", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    for (const container of ["web-abc;id", "web$(id)", "-f"]) {
      const res = await h.request(
        "GET",
        logsPath(
          connectionId,
          "app-web-uuid",
          `?container=${encodeURIComponent(container)}`,
        ),
      );
      expect(res.status).toBe(400);
    }
    expect(docker.commands).toEqual([]);
  });

  it("uses sudo -n for a user outside the docker group", async () => {
    const { harness: h, connectionId } = await start();
    setSensitive(h, connectionId, false);
    const docker = fakeDocker(h, {
      uid: 1000,
      groups: "deploy",
      ps: [WEB_RUNNING],
    });
    await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(docker.commands).toContain(
      "sudo -n docker logs --tail '100' 'web-abc' 2>&1",
    );
  });

  it("another user's connection is a 404 and reads nothing", async () => {
    const { harness: h, fake, connectionId } = await start();
    const before = logCalls(fake).length;
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const res = await h.request(
      "GET",
      logsPath(connectionId, "app-web-uuid"),
      undefined,
      OTHER,
    );
    expect(res.status).toBe(404);
    expect(docker.commands).toEqual([]);
    expect(logCalls(fake).length).toBe(before);
  });

  it("without coolify.operate 403", async () => {
    const { harness: h, connectionId } = await start({
      permissions: ["coolify.view", "coolify.configure"],
    });
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const res = await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(res.status).toBe(403);
    expect(docker.commands).toEqual([]);
  });
});

/** Stands in for an ssh2 exec channel. */
class FakeStream extends EventEmitter {
  stderr = new EventEmitter();
  signals: string[] = [];
  closed = false;
  signal(name: string) {
    this.signals.push(name);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

/** ctx.ssh.connect answering a client whose exec opens FakeStreams. */
function fakeFollowSsh(h: PluginHarness) {
  const execs: { command: string; options: unknown; stream: FakeStream }[] = [];
  const dispose = vi.fn();
  const client = {
    exec(
      command: string,
      options: unknown,
      callback: (err: Error | undefined, stream: FakeStream) => void,
    ) {
      const stream = new FakeStream();
      execs.push({ command, options, stream });
      callback(undefined, stream);
      return true;
    },
  };
  const connect = vi.spyOn(h.mock.ctx.ssh, "connect").mockResolvedValue({
    client,
    jumpClient: null,
    host: { id: HOST_ID, ip: "203.0.113.5", port: 22, username: "deploy" },
    dispose,
  } as never);
  return { execs, dispose, connect };
}

/** Stands in for the ws socket core hands a socket route. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  closedWith: number | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = code ?? 1000;
    this.emit("close");
  }
  message(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
}

function openFollow(h: PluginHarness, user = OWNER) {
  const route = h.mock.wsRoutes.find((r) => r.path === "/logs");
  if (!route?.handler) throw new Error("no /logs socket route");
  const socket = new FakeSocket();
  const state = { unlocked: true };
  // Core runs a socket's events as the user who opened it.
  h.mock.setActor(user);
  void route.handler({
    userId: user,
    request: {},
    socket,
    clientIp: "198.51.100.2",
    requestOrigin: "https://termix.test",
    isDataUnlocked: () => state.unlocked,
  });
  return { socket, state };
}

function sentOf(socket: FakeSocket, type: string) {
  return socket.sent.filter((m) => m.type === type);
}

describe("logs follow socket", () => {
  async function following() {
    const started = await start();
    setSensitive(started.harness, started.connectionId, true);
    fakeDocker(started.harness, { ps: [WEB_RUNNING] });
    const ssh = fakeFollowSsh(started.harness);
    const { socket, state } = openFollow(started.harness);
    socket.message({
      type: "subscribe",
      connectionId: started.connectionId,
      uuid: "app-web-uuid",
    });
    await eventually(() => expect(sentOf(socket, "started")).toHaveLength(1));
    return { ...started, ssh, socket, state };
  }

  it("streams new lines of docker logs -f over SSH, labelled ssh", async () => {
    const { ssh, socket } = await following();
    expect(sentOf(socket, "started")[0]).toEqual({
      type: "started",
      source: "ssh",
      container: "web-abc",
    });
    expect(ssh.connect).toHaveBeenCalledWith(HOST_ID, expect.anything());
    expect(ssh.execs).toHaveLength(1);
    expect(ssh.execs[0].command).toBe(
      "docker logs -f --tail '0' 'web-abc' 2>&1",
    );
    ssh.execs[0].stream.emit("data", Buffer.from("one\r\ntwo\nthr"));
    ssh.execs[0].stream.emit("data", Buffer.from("ee\n"));
    await eventually(() =>
      expect(
        sentOf(socket, "lines").flatMap((m) => m.lines as string[]),
      ).toEqual(["one", "two", "three"]),
    );
  });

  it("stops and kills the SSH process when the socket closes", async () => {
    const { ssh, socket } = await following();
    socket.close();
    const stream = ssh.execs[0].stream;
    expect(stream.signals).toContain("KILL");
    expect(stream.closed).toBe(true);
    expect(ssh.dispose).toHaveBeenCalled();
  });

  it("stops on unsubscribe and keeps the socket open", async () => {
    const { ssh, socket } = await following();
    socket.message({ type: "unsubscribe" });
    await eventually(() => expect(sentOf(socket, "stopped")).toHaveLength(1));
    expect(ssh.execs[0].stream.signals).toContain("KILL");
    expect(ssh.dispose).toHaveBeenCalled();
    expect(socket.closedWith).toBeNull();
  });

  it("follow socket checks isDataUnlocked on every message", async () => {
    const { ssh, socket, state, connectionId } = await following();
    state.unlocked = false;
    socket.message({ type: "ping" });
    await eventually(() => expect(socket.closedWith).toBe(1008));
    expect(sentOf(socket, "error").at(-1)).toMatchObject({ cause: "locked" });
    expect(ssh.execs[0].stream.signals).toContain("KILL");
    expect(ssh.dispose).toHaveBeenCalled();

    // A locked session never starts one.
    const second = openFollow(harness!);
    second.state.unlocked = false;
    const before = ssh.connect.mock.calls.length;
    second.socket.message({
      type: "subscribe",
      connectionId,
      uuid: "app-web-uuid",
    });
    await eventually(() => expect(second.socket.closedWith).toBe(1008));
    expect(ssh.connect.mock.calls.length).toBe(before);
  });

  it("checks access again on every message and stops when it is gone", async () => {
    const { ssh, socket, harness: h } = await following();
    vi.spyOn(h.mock.ctx.hosts, "checkAccess").mockResolvedValue({
      hasAccess: false,
      isOwner: false,
      isShared: false,
    });
    socket.message({ type: "ping" });
    await eventually(() => expect(socket.closedWith).toBe(1008));
    expect(sentOf(socket, "error").at(-1)).toMatchObject({
      cause: "no-host-access",
    });
    expect(ssh.dispose).toHaveBeenCalled();
  });

  it("follow socket refuses another user's connection", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const ssh = fakeFollowSsh(h);
    const { socket } = openFollow(h, OTHER);
    socket.message({ type: "subscribe", connectionId, uuid: "app-web-uuid" });
    await eventually(() => expect(socket.closedWith).toBe(1008));
    expect(sentOf(socket, "error").at(-1)).toMatchObject({
      cause: "not-found",
    });
    expect(ssh.connect).not.toHaveBeenCalled();
    expect(docker.commands).toEqual([]);
  });

  it("refuses a message that doesn't run as the socket's own user", async () => {
    const { harness: h, connectionId } = await start();
    const ssh = fakeFollowSsh(h);
    const { socket } = openFollow(h, OTHER);
    h.mock.setActor(OWNER);
    socket.message({ type: "subscribe", connectionId, uuid: "app-web-uuid" });
    await eventually(() => expect(socket.closedWith).toBe(1008));
    expect(sentOf(socket, "error").at(-1)).toMatchObject({
      cause: "forbidden",
    });
    expect(ssh.connect).not.toHaveBeenCalled();
  });

  it("refuses a user without coolify.operate before any SSH", async () => {
    const { harness: h, connectionId } = await start({
      permissions: ["coolify.view", "coolify.configure"],
    });
    const ssh = fakeFollowSsh(h);
    const { socket } = openFollow(h);
    socket.message({ type: "subscribe", connectionId, uuid: "app-web-uuid" });
    await eventually(() => expect(socket.closedWith).toBe(1008));
    expect(sentOf(socket, "error").at(-1)).toMatchObject({
      cause: "forbidden",
    });
    expect(ssh.connect).not.toHaveBeenCalled();
  });

  it("no linked host answers not-linked on the socket", async () => {
    const { harness: h, connectionId } = await start();
    const ssh = fakeFollowSsh(h);
    const { socket } = openFollow(h);
    socket.message({ type: "subscribe", connectionId, uuid: "app-api-uuid" });
    await eventually(() => expect(sentOf(socket, "error")).toHaveLength(1));
    expect(sentOf(socket, "error")[0]).toMatchObject({ cause: "not-linked" });
    expect(ssh.connect).not.toHaveBeenCalled();
  });

  it("masks secrets in followed lines", async () => {
    const { ssh, socket } = await following();
    ssh.execs[0].stream.emit("data", Buffer.from(LEAKY));
    await eventually(() =>
      expect(
        sentOf(socket, "lines").flatMap((m) => m.lines as string[]),
      ).toContain("plain line"),
    );
    expectMasked(
      sentOf(socket, "lines")
        .flatMap((m) => m.lines as string[])
        .join("\n"),
    );
  });

  const wide = `FAKEFOLLOWBODY${"B".repeat(50)}\n`;
  it.each([
    ["the whole tail in one chunk", [KEY_TAIL.text]],
    [
      "PEM-wide body lines, a line a chunk, as docker logs -f writes them",
      [wide, wide, "FAKEFOLLOWEND==\n", `${KEY_TAIL.end}\n${KEY_TAIL.after}\n`],
    ],
  ])(
    "a follow that starts inside a private key sends none of it: %s",
    async (_name, chunks) => {
      const { ssh, socket } = await following();
      for (const chunk of chunks) {
        ssh.execs[0].stream.emit("data", Buffer.from(chunk));
      }
      const sent = () =>
        sentOf(socket, "lines")
          .flatMap((m) => m.lines as string[])
          .join("\n");
      await eventually(() => expect(sent()).toContain(KEY_TAIL.after));
      expectKeyTailMasked(sent());
      expect(sent()).not.toContain("FAKEFOLLOW");
    },
  );

  it("masks the token when it straddles the long-line split", async () => {
    const { ssh, socket } = await following();
    const stream = ssh.execs[0].stream;
    stream.emit("data", Buffer.from("x".repeat(MAX_LINE - 5) + TOKEN));
    stream.emit("data", Buffer.from("y".repeat(MAX_LINE * 2)));
    stream.emit("data", Buffer.from(" password=" + "z".repeat(3)));
    stream.emit("data", Buffer.from("zzzz-tail\nnext\n"));
    await eventually(() =>
      expect(
        sentOf(socket, "lines").flatMap((m) => m.lines as string[]),
      ).toContain("next"),
    );
    const pieces = sentOf(socket, "lines").flatMap((m) => m.lines as string[]);
    expect(pieces.length).toBeGreaterThan(2);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(MAX_LINE);
      for (const part of [TOKEN, TOKEN.slice(0, 6), TOKEN.slice(-6), "zzz"]) {
        expect(piece).not.toContain(part);
      }
    }
  });

  it("keeps a multibyte character split across SSH chunks", async () => {
    const { ssh, socket } = await following();
    const bytes = Buffer.from("a界b\n");
    ssh.execs[0].stream.emit("data", bytes.subarray(0, 2));
    ssh.execs[0].stream.emit("data", bytes.subarray(2));
    await eventually(() =>
      expect(
        sentOf(socket, "lines").flatMap((m) => m.lines as string[]),
      ).toEqual(["a界b"]),
    );
  });

  it("sends every buffered line before ended when docker logs closes", async () => {
    const { ssh, socket } = await following();
    const many = Array.from({ length: 1_000 }, (_, i) => `line ${i}`);
    ssh.execs[0].stream.emit("data", Buffer.from(many.join("\n") + "\n"));
    ssh.execs[0].stream.close();
    await eventually(() => expect(sentOf(socket, "ended")).toHaveLength(1));
    const sent = sentOf(socket, "lines").flatMap((m) => m.lines as string[]);
    expect(sent).toEqual(many);
    // ended comes after the last batch.
    expect(socket.sent.at(-1)).toEqual({ type: "ended" });
    for (const m of sentOf(socket, "lines")) {
      expect((m.lines as string[]).length).toBeLessThanOrEqual(500);
    }
  });

  it("a target change stops the follow on the next message", async () => {
    const { ssh, socket, harness: h } = await following();
    repoint(h);
    socket.message({ type: "ping" });
    await eventually(() =>
      expect(sentOf(socket, "error").at(-1)).toMatchObject({
        cause: "target-changed",
      }),
    );
    expect(ssh.execs[0].stream.signals).toContain("KILL");
    expect(ssh.dispose).toHaveBeenCalled();
  });

  it("checks the target and access periodically without any message", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { ssh, socket, harness: h } = await following();
    repoint(h);
    await vi.advanceTimersByTimeAsync(RECHECK_MS + 10);
    await eventually(() =>
      expect(sentOf(socket, "error").at(-1)).toMatchObject({
        cause: "target-changed",
      }),
    );
    expect(ssh.dispose).toHaveBeenCalled();
  });

  it("a revoked grant stops the follow periodically", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { harness: h, connectionId } = await start();
    h.db.sqlite
      .prepare(
        "INSERT INTO p_coolify_grants (connection_id, user_id, level) VALUES (?, ?, 'operate')",
      )
      .run(connectionId, OTHER);
    fakeDocker(h, { ps: [WEB_RUNNING] });
    const ssh = fakeFollowSsh(h);
    const { socket } = openFollow(h, OTHER);
    socket.message({ type: "subscribe", connectionId, uuid: "app-web-uuid" });
    await eventually(() => expect(sentOf(socket, "started")).toHaveLength(1));
    h.db.sqlite.prepare("DELETE FROM p_coolify_grants").run();
    await vi.advanceTimersByTimeAsync(RECHECK_MS + 10);
    await eventually(() => expect(socket.closedWith).toBe(1008));
    expect(ssh.dispose).toHaveBeenCalled();
  });

  it("a view grant can't follow", async () => {
    const { harness: h, connectionId } = await start();
    h.db.sqlite
      .prepare(
        "INSERT INTO p_coolify_grants (connection_id, user_id, level) VALUES (?, ?, 'view')",
      )
      .run(connectionId, OTHER);
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const ssh = fakeFollowSsh(h);
    const { socket } = openFollow(h, OTHER);
    socket.message({ type: "subscribe", connectionId, uuid: "app-web-uuid" });
    await eventually(() => expect(socket.closedWith).toBe(1008));
    expect(sentOf(socket, "error").at(-1)).toMatchObject({
      cause: "forbidden",
    });
    expect(ssh.connect).not.toHaveBeenCalled();
    expect(docker.commands).toEqual([]);
  });

  it("a second subscribe on one socket ends the first SSH process", async () => {
    const { ssh, socket, connectionId } = await following();
    socket.message({ type: "subscribe", connectionId, uuid: "app-web-uuid" });
    await eventually(() => expect(ssh.execs).toHaveLength(2));
    expect(ssh.execs[0].stream.signals).toContain("KILL");
    expect(ssh.dispose).toHaveBeenCalledTimes(1);
  });

  it("ends when docker logs ends on its own", async () => {
    const { ssh, socket } = await following();
    ssh.execs[0].stream.emit("data", Buffer.from("last words"));
    ssh.execs[0].stream.close();
    await eventually(() => expect(sentOf(socket, "ended")).toHaveLength(1));
    expect(sentOf(socket, "lines").flatMap((m) => m.lines as string[])).toEqual(
      ["last words"],
    );
    expect(ssh.dispose).toHaveBeenCalled();
  });
});
