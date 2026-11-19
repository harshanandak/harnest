import { z } from "zod";
import { RoutingSettings } from "./routing-settings.mjs";

const target = z.enum(["pi", "opencode", "claude", "codex", "cursor", "amp", "acp"]);
const preset = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const object = z.record(z.string(), z.unknown());
export const routingSettingsSchema = z.object({
  harnessOrder: z.array(target).min(1).max(8).nullable().optional(),
  tier: z.enum(["quick", "balanced", "deep", "review"]).nullable().optional(),
  models: z.partialRecord(target, z.string().trim().min(1).max(300).nullable()).nullable().optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).nullable().optional(),
  modelVersion: z.enum(["latest", "pin"]).nullable().optional(),
  fallbacks: z.boolean().nullable().optional(),
  allowTrainingEndpoints: z.boolean().nullable().optional(),
}).strict();

export function routingToolDefinitions(settings, options = {}) {
  settings ??= new RoutingSettings(options);
  const definitions = [
    ["get", "Show the active routing preset, base preferences, saved presets, revision and advanced overrides. Read this before changing routing.", z.object({}).strict(), true, () => settings.get()],
    ["configure", "Change routing for future handoffs in the canonical user file. Supply the revision returned by get. set patches base settings (null clears); save-preset replaces a named preset; use-preset selects it (null restores base); delete-preset removes an inactive preset. modelVersion latest follows new releases within the chosen family/tier; pin keeps the exact model ID. Preserve explicit user intent; discover model IDs first. A preset name such as free does not enforce a price limit. Preview the actual route afterward.", z.object({
      action: z.enum(["set", "save-preset", "use-preset", "delete-preset"]),
      expectedRevision: z.union([z.literal("missing"), z.string().regex(/^[a-f0-9]{64}$/)]),
      preset: preset.nullable().optional(),
      settings: routingSettingsSchema.optional(),
    }).strict(), false, (input) => settings.configure(input)],
    ["preview", "Explain a task's route for a saved-policy snapshot using the actual selector and configured resolver, without launching a handoff. Show target, provider, model, thinking and overrides. Runtime circuit-breaker and last-known-good policy state are not shared; host config and executable hooks stay process-cached. An optional preset applies only to this preview (null selects base). Pass the same task, target, route and routing metadata intended for execution.", z.object({
      request: z.object({ task: z.string().trim().min(1).max(100000), cwd: z.string().min(1).optional(), target: z.enum(["auto", "pi", "opencode", "claude", "codex", "cursor", "amp", "acp"]).optional(), route: object.optional(), metadata: object.optional(), policy: object.optional(), context: object.optional(), execution: object.optional() }).strict(),
      preset: preset.nullable().optional(),
    }).strict(), true, (input) => settings.preview(input)],
  ];
  return definitions.map(([suffix, description, inputSchema, readOnlyHint, run]) => ({
    name: `handoff_routing_${suffix}`, description, inputSchema,
    parameters: z.toJSONSchema(inputSchema), readOnlyHint, run,
  }));
}

export function registerRoutingTools(server, { settings, settingsOptions, dataResponse, failure }) {
  for (const tool of routingToolDefinitions(settings, settingsOptions)) {
    server.registerTool(tool.name, {
      title: tool.name.replaceAll("_", " "), description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: tool.readOnlyHint, destructiveHint: !tool.readOnlyHint },
    }, async (input) => {
      try { return dataResponse("routing", await tool.run(tool.inputSchema.parse(input))); }
      catch (error) { return failure(error); }
    });
  }
}
