import {
  parseOperationInput,
  redactFields,
  type OperationAction,
} from "@termix-ssh/plugin-sdk/operations";
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
    async run(id: string, input: Record<string, unknown> = {}) {
      const declared = action(id);
      const parsed = parseOperationInput(declared.inputs, input);
      if (parsed.errors.length) {
        throw new Error(`refused input: ${parsed.errors.join("; ")}`);
      }
      const outcome = await mock.ctx.operations.run(id, {
        input: parsed.values,
      });
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
