// Pure edits to Claude Code's settings.json for the inbox hook. They touch
// nothing but the hook's own entry, and refuse shapes they don't recognise
// instead of guessing, so a user's other settings are never rewritten.

type Json = unknown;
type Settings = Readonly<Record<string, Json>>;
type HookGroup = { readonly matcher?: string; readonly hooks: readonly { readonly type?: string; readonly command?: string; readonly timeout?: number }[] };

/** Ours, wherever this checkout was installed from. */
const isInboxHook = (command: unknown) => typeof command === "string" && /agent-mailbox\/src\/hook\.ts"?$/.test(command.trim());

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

/** Every send then shows the user a permission prompt, in every mode but dontAsk, even if an allow rule also matches. */
export const SEND_ASK_RULE = "mcp__agent-mailbox__mailbox_send";

function askRulesOf(settings: Settings): { readonly permissions: Settings; readonly ask: readonly string[] } {
  const permissions = settings["permissions"] ?? {};
  if (!isObject(permissions)) throw new Error("settings.json has a permissions value that is not an object");
  const ask = permissions["ask"] ?? [];
  if (!Array.isArray(ask) || !ask.every((rule) => typeof rule === "string")) throw new Error("settings.json has a permissions.ask value that is not a list of rules");
  return { permissions, ask: ask as string[] };
}

function withAskRules(settings: Settings, ask: readonly string[]): Settings {
  const { permissions } = askRulesOf(settings);
  const { ask: _old, ...otherRules } = permissions;
  const nextPermissions = ask.length > 0 ? { ...otherRules, ask } : otherRules;
  const { permissions: _permissions, ...rest } = settings;
  return Object.keys(nextPermissions).length > 0 ? { ...rest, permissions: nextPermissions } : rest;
}

/** Takes out the inbox hook only. The send rule stays: turning off notices must not turn off approval. */
export function withoutHook(input: Json): Settings {
  const { settings, hooks, groups } = groupsOf(input);
  askRulesOf(settings); // refuse a malformed permissions block before changing anything
  const kept = groups.map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isInboxHook(h.command)) })).filter((g) => g.hooks.length > 0);
  return rebuild(settings, hooks, kept);
}

/** Takes out the send rule. Only uninstall does this. */
export function withoutAskRule(input: Json): Settings {
  const { settings } = groupsOf(input);
  return withAskRules(settings, askRulesOf(settings).ask.filter((rule) => rule !== SEND_ASK_RULE));
}

export function withHook(input: Json, command: string): Settings {
  const cleared = withoutAskRule(withoutHook(input));
  const { settings, hooks, groups } = groupsOf(cleared);
  const hooked = rebuild(settings, hooks, [...groups, { hooks: [{ type: "command", command, timeout: 5 }] }]);
  return withAskRules(hooked, [...askRulesOf(hooked).ask, SEND_ASK_RULE]);
}

export function hasAskRule(input: Json): boolean {
  try {
    return askRulesOf(groupsOf(input).settings).ask.includes(SEND_ASK_RULE);
  } catch {
    return false;
  }
}

/** Whether these settings already run the inbox hook, from any install path. */
export function hasHook(input: Json): boolean {
  try {
    return groupsOf(input).groups.some((g) => g.hooks.some((h) => isInboxHook(h.command)));
  } catch {
    return false;
  }
}
