import { describe, expect, it } from "vitest";
import { QUEUE_TTL_MS } from "../../../src/backend/deployments/queue.js";
import { SERVERS_TTL_MS } from "../../../src/backend/ops/signals.js";
import { RESOURCE_TTL_MS } from "../../../src/backend/resources/service.js";
import {
  CARD_POLL_MS,
  VULNERABILITIES_TTL_MS,
} from "../../../src/shared/dashboard.js";

describe("dashboard card polling", () => {
  it("never reads faster than the backend caches each card reads turn over", () => {
    // The overview reads resources and server statuses.
    expect(CARD_POLL_MS.overview).toBeGreaterThanOrEqual(
      Math.max(RESOURCE_TTL_MS, SERVERS_TTL_MS),
    );
    expect(CARD_POLL_MS.resource).toBeGreaterThanOrEqual(RESOURCE_TTL_MS);
    expect(CARD_POLL_MS.deployments).toBeGreaterThanOrEqual(QUEUE_TTL_MS);
    expect(CARD_POLL_MS.vulnerabilities).toBeGreaterThanOrEqual(
      VULNERABILITIES_TTL_MS,
    );
  });
});
