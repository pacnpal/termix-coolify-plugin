import {
  parseOperationInput,
  redactFields,
  type OperationAction,
} from "@termix-ssh/plugin-sdk/operations";
import type { PluginOperationOutcome } from "@termix-ssh/plugin-sdk/backend";
import type { MockPluginContext } from "@termix-ssh/plugin-sdk/testing";
import { manifest } from "./plugin.js";

export interface RecordedRun {
  actionId: string;
  input: unknown;
  summary: string | undefined;
  data: unknown;
}

function action(id: string): OperationAction {
  const found = manifest.contributes?.operations?.actions?.find(
    (a) => a.id === id,
  );
  if (!found) throw new Error(`${id} is not declared in manifest.json`);
  return found;
}

/**
 * Calls the handler the way core does for a stored run. The mock's
 * ctx.operations.run always passes a null runId; core passes the run's id,
 * for example when an approval lets a waiting run go ahead.
 */
async function runWithId(
  mock: MockPluginContext,
  id: string,
  input: Record<string, unknown>,
  runId: string,
): Promise<PluginOperationOutcome> {
  const handler = mock.operationHandlers.get(id);
  if (!handler) throw new Error(`No action "${id}"`);
  const result = await handler.run(input, {
    runId,
    dryRun: false,
    signal: new AbortController().signal,
    log: () => {},
  });
  return { runId, status: "success", ...result };
}

/**
 * Runs an action the way core does around a handler, and keeps the run as
 * core's history would. The mock ctx records no runs itself, so this applies
 * the same SDK steps core applies: inputs go through parseOperationInput
 * (undeclared keys refused), and the stored copy goes through redactFields
 * with the manifest's own declarations, so a `secret` input or `sensitive`
 * output is replaced before it is kept. Whatever the handler puts in its
 * summary or undeclared data is kept as it is, which is what these tests catch.
 */
export function withRunHistory(mock: MockPluginContext) {
  const history: RecordedRun[] = [];
  return {
    history,
    /** With `runId`, the handler gets that run id, as core passes it. */
    async run(
      id: string,
      input: Record<string, unknown> = {},
      opts: { runId?: string } = {},
    ) {
      const declared = action(id);
      const parsed = parseOperationInput(declared.inputs, input);
      if (parsed.errors.length) {
        throw new Error(`refused input: ${parsed.errors.join("; ")}`);
      }
      const outcome = opts.runId
        ? await runWithId(mock, id, parsed.values, opts.runId)
        : await mock.ctx.operations.run(id, { input: parsed.values });
      history.push({
        actionId: id,
        input: redactFields(declared.inputs, parsed.values),
        summary: outcome.summary,
        data: redactFields(declared.outputs, outcome.data),
      });
      return outcome;
    },
  };
}
