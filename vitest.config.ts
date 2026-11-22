import { fileURLToPath } from "node:url";
import { pluginVitestConfig } from "@termix-ssh/plugin-sdk/vitest-preset";

const config = pluginVitestConfig(import.meta.url);

// The frontend tests also load tests/frontend/setup.ts: findBy and waitFor
// wait for fixed work, so they get a margin over Testing Library's 1 s (#105).
const frontendSetup = fileURLToPath(
  new URL("./tests/frontend/setup.ts", import.meta.url),
);
for (const project of config.test.projects) {
  if (project.test.environment === "jsdom") {
    project.test.setupFiles.push(frontendSetup);
  }
}

export default config;
