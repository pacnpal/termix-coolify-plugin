import { describe, expect, it } from "vitest";
import type { ResourceDto } from "../../../src/backend/coolify/dto.js";
import { describeDeploy } from "../../../src/backend/ops/lifecycle.js";
import { describeRollback } from "../../../src/backend/ops/rollback.js";

function resource(name: string, serverName: string | null): ResourceDto {
  return {
    uuid: "app-1",
    id: 1,
    name,
    kind: "application",
    status: "running",
    serverUuid: "srv-1",
    serverName,
    projectName: null,
    environmentName: null,
    fqdns: [],
    parentUuid: null,
    engine: null,
    lastDeployAt: null,
    buildPack: null,
  };
}

const PATTERNS = "web-$& $1 $$ $` $'";

describe("dry-run summaries", () => {
  it("keep $ patterns in a name as they are", () => {
    expect(describeDeploy(resource(PATTERNS, "box $& $$"))).toBe(
      "Would deploy web-$& $1 $$ $` $' on box $& $$",
    );
    expect(describeRollback(PATTERNS, "v1")).toBe(
      "Would roll back web-$& $1 $$ $` $' to image v1",
    );
  });

  it("never fill a placeholder that came in with a name", () => {
    expect(describeDeploy(resource("x {{server}} {{name}}", "box"))).toBe(
      "Would deploy x {{server}} {{name}} on box",
    );
    expect(describeRollback("x {{image}} {{name}}", "v1")).toBe(
      "Would roll back x {{image}} {{name}} to image v1",
    );
  });

  it("names the server by uuid, then in words, when it has no name", () => {
    expect(describeDeploy(resource("web", null))).toBe(
      "Would deploy web on srv-1",
    );
    expect(describeDeploy({ ...resource("web", null), serverUuid: null })).toBe(
      "Would deploy web on its Coolify server",
    );
  });
});
