import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

export async function activate(_ctx: PluginContext): Promise<void> {
  // Connections, host sync, resources and the rest are wired here by later work.
}

export async function deactivate(): Promise<void> {
  // Everything registered through ctx is disposed by core.
}
