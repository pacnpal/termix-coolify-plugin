import { describe, expect, it } from "vitest";
import { REDACTED_VALUE } from "@termix-ssh/plugin-sdk/operations";
import { redact } from "../../src/backend/redact.js";

const FAKES = [
  "fake-token-redact",
  "fake-password-redact",
  "fake-private-key-redact",
  "fake-env-value-redact",
  "fake-compose-redact",
  "fake-label-redact",
  "fake-dockerfile-redact",
  "fake-logdrain-redact",
];

describe("redact", () => {
  it("masks token, password, private_key, value and compose blobs at any depth", () => {
    const input = {
      name: "app",
      token: FAKES[0],
      nested: {
        deeper: [
          { DB_PASSWORD: FAKES[1] },
          { server: { private_key: FAKES[2] } },
          { key: "API_URL", value: FAKES[3], real_value: FAKES[3] },
        ],
      },
      application: {
        docker_compose_raw: `services:\n  web:\n    environment:\n      - X=${FAKES[4]}`,
        docker_compose: `services:\n  web:\n    environment:\n      - X=${FAKES[4]}`,
        custom_labels: FAKES[5],
        dockerfile: `ENV SECRET=${FAKES[6]}`,
      },
      servers: [{ settings: { logdrain_newrelic_config: FAKES[7] } }],
    };
    const out = redact(input) as any;
    const text = JSON.stringify(out);
    for (const fake of FAKES) expect(text).not.toContain(fake);
    expect(out.name).toBe("app");
    expect(out.token).toBe(REDACTED_VALUE);
    expect(out.nested.deeper[0].DB_PASSWORD).toBe(REDACTED_VALUE);
    expect(out.nested.deeper[1].server.private_key).toBe(REDACTED_VALUE);
    expect(out.nested.deeper[2]).toEqual({
      key: "API_URL",
      value: REDACTED_VALUE,
      real_value: REDACTED_VALUE,
    });
    expect(out.application.docker_compose_raw).toBe(REDACTED_VALUE);
    expect(out.application.docker_compose).toBe(REDACTED_VALUE);
    expect(out.application.custom_labels).toBe(REDACTED_VALUE);
    expect(out.application.dockerfile).toBe(REDACTED_VALUE);
    expect(out.servers[0].settings.logdrain_newrelic_config).toBe(
      REDACTED_VALUE,
    );
  });

  it("masks every key the design names, in any case, and leaves the rest", () => {
    const keys = [
      "token",
      "secret",
      "password",
      "passwd",
      "private_key",
      "api_key",
      "apikey",
      "webhook_secret",
      "value",
      "real_value",
      "license",
      "key_pem",
      "client_secret",
      "dsn",
      "ACCESS_TOKEN",
      "Sentry_DSN",
    ];
    const out = redact(
      Object.fromEntries(keys.map((k) => [k, "fake-x"])),
    ) as Record<string, unknown>;
    for (const key of keys) expect(out[key], key).toBe(REDACTED_VALUE);
    expect(
      redact({ uuid: "u1", fqdn: "app.example.test", status: "running" }),
    ).toEqual({ uuid: "u1", fqdn: "app.example.test", status: "running" });
  });

  it("masks a secret key's object or array value whole", () => {
    const out = redact({
      secret: { nested: "fake-x" },
      tokens: ["fake-y"],
    }) as Record<string, unknown>;
    expect(out.secret).toBe(REDACTED_VALUE);
    // "tokens" does not end in a secret word, but its items are plain strings.
    expect(out.tokens).toEqual(["fake-y"]);
  });

  it("keeps nulls, does not change its input and passes plain values through", () => {
    const input = { token: null, list: [1, "a", true], value: "fake-x" };
    const out = redact(input) as Record<string, unknown>;
    expect(out.token).toBeNull();
    expect(out.list).toEqual([1, "a", true]);
    expect(input.value).toBe("fake-x");
    expect(redact("plain")).toBe("plain");
    expect(redact(3)).toBe(3);
    expect(redact(null)).toBeNull();
  });
});

describe("redact: credentials inside values", () => {
  const PW = "fake-db-password-redact";

  it("masks a URL's userinfo password in any field, at any depth", () => {
    const out = redact({
      note: { list: [`see postgres://admin:${PW}@db:5432/app for it`] },
    });
    expect(JSON.stringify(out)).not.toContain(PW);
    expect(out).toEqual({
      note: {
        list: [`see postgres://admin:${REDACTED_VALUE}@db:5432/app for it`],
      },
    });
  });

  it("masks credential query parameters and keeps the others", () => {
    expect(
      redact({ link: `https://x.test/a?token=${PW}&page=2&Password=${PW}` }),
    ).toEqual({
      link: `https://x.test/a?token=${REDACTED_VALUE}&page=2&Password=${REDACTED_VALUE}`,
    });
    expect(redact({ link: `https://x.test/a?key=${PW}` })).toEqual({
      link: `https://x.test/a?key=${REDACTED_VALUE}`,
    });
  });

  it("keeps a *_db_url as a URL with its password masked; an unparsable one is masked whole", () => {
    expect(
      redact({
        internal_db_url: `postgres://postgres:${PW}@db-uuid:5432/postgres`,
        external_db_url: "not a url",
      }),
    ).toEqual({
      internal_db_url: `postgres://postgres:${REDACTED_VALUE}@db-uuid:5432/postgres`,
      external_db_url: REDACTED_VALUE,
    });
  });

  it.each([
    "manual_webhook_secret_github",
    "influxdb_admin_password",
    "deploy_key",
    "api_token",
    "client_secret",
    "dsn",
  ])("masks %s (by name or from the vendored schemas)", (key) => {
    expect(redact({ [key]: PW })).toEqual({ [key]: REDACTED_VALUE });
  });

  it("leaves plain values and an env var's name alone", () => {
    expect(
      redact({ key: "DB_URL", fqdn: "https://app.test/a?page=2", port: 5432 }),
    ).toEqual({ key: "DB_URL", fqdn: "https://app.test/a?page=2", port: 5432 });
  });
});
