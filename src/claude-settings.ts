// Pure edits to Claude Code's settings.json for the inbox hook. They touch
// nothing but the hook's own entry, and refuse shapes they don't recognise
// instead of guessing, so a user's other settings are never rewritten.

type Json = unknown;
type Settings = Readonly<Record<string, Json>>;
type HookGroup = { readonly matcher?: string; readonly hooks: readonly { readonly type?: string; readonly command?: string; readonly timeout?: number }[] };

/** Ours, wherever this checkout was installed from. */
const isInboxHook = (command: unknown) => typeof command === "string" && /agent-mailbox\/src\/hook\.ts$/.test(command.trim());

const isObject = (value: Json): value is Settings => typeof value === "object" && value !== null && !Array.isArray(value);

function groupsOf(settings: Json): { readonly settings: Settings; readonly hooks: Settings; readonly groups: readonly HookGroup[] } {
  if (!isObject(settings)) throw new Error("settings.json is not a JSON object");
  const hooks = settings["hooks"] ?? {};
  if (!isObject(hooks)) throw new Error("settings.json has a hooks value that is not an object");
  const groups = hooks["UserPromptSubmit"] ?? [];
  if (!Array.isArray(groups) || !groups.every((g) => isObject(g) && Array.isArray(g["hooks"]))) throw new Error("settings.json has a UserPromptSubmit value that is not a list of hook groups");
  return { settings, hooks, groups: groups as HookGroup[] };
}

function rebuild(settings: Settings, hooks: Settings, groups: readonly HookGroup[]): Settings {
  const { UserPromptSubmit: _old, ...otherEvents } = hooks;
  const nextHooks = groups.length > 0 ? { ...otherEvents, UserPromptSubmit: groups } : otherEvents;
  const { hooks: _hooks, ...rest } = settings;
  return Object.keys(nextHooks).length > 0 ? { ...rest, hooks: nextHooks } : rest;
}

export function withoutHook(input: Json): Settings {
  const { settings, hooks, groups } = groupsOf(input);
  const kept = groups.map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isInboxHook(h.command)) })).filter((g) => g.hooks.length > 0);
  return rebuild(settings, hooks, kept);
}

export function withHook(input: Json, command: string): Settings {
  const cleared = withoutHook(input);
  const { settings, hooks, groups } = groupsOf(cleared);
  return rebuild(settings, hooks, [...groups, { hooks: [{ type: "command", command, timeout: 5 }] }]);
}
