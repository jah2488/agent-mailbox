// A strict subset of TOML, enough for config.toml and no more: comments,
// [tables] and [nested.tables], bare keys, and values that are strings (basic
// or literal), true/false, integers, or one-line arrays of one of those.
// Anything else is refused with its line number rather than guessed at, so a
// config file means exactly one thing. Written by hand to avoid a dependency.

export type TomlValue = string | number | boolean | readonly TomlValue[] | TomlTable;
export type TomlTable = { readonly [key: string]: TomlValue };
export type Parsed = { readonly ok: true; readonly value: TomlTable } | { readonly ok: false; readonly error: string };

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
const UNSUPPORTED = (v: string) => `unsupported value ${v} (strings, true/false, integers and arrays only)`;

class TomlError extends Error {}
const fail = (message: string): never => {
  throw new TomlError(message);
};

/** Reads one value starting at text[i]; returns it and the index just past it. */
function readValue(text: string, i: number): [TomlValue, number] {
  const c = text[i];
  if (c === '"' || c === "'") {
    if (text.startsWith(c.repeat(3), i)) fail("multi-line strings aren't supported");
    return readString(text, i);
  }
  if (c === "[") return readArray(text, i);
  if (c === "{") fail("inline tables aren't supported; use a [table]");
  const token = /^[^\s,\]#]+/.exec(text.slice(i))?.[0] ?? "";
  if (token === "true" || token === "false") return [token === "true", i + token.length];
  if (/^[+-]?(0|[1-9][0-9]*)$/.test(token)) {
    const n = Number(token);
    if (!Number.isSafeInteger(n)) fail("integer out of range");
    return [n, i + token.length];
  }
  return fail(token === "" ? "missing value" : UNSUPPORTED(token));
}

function readString(text: string, i: number): [string, number] {
  const quote = text[i]!;
  let out = "";
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j]!;
    if (c === quote) return [out, j + 1];
    if (quote === '"' && c === "\\") {
      const e = text[j + 1] ?? "";
      if (e === "u") {
        const hex = text.slice(j + 2, j + 6);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail("bad escape \\u" + hex);
        out += String.fromCharCode(parseInt(hex, 16));
        j += 5;
      } else if (ESCAPES[e] !== undefined) {
        out += ESCAPES[e];
        j += 1;
      } else {
        fail(`bad escape \\${e}`);
      }
    } else {
      out += c;
    }
  }
  return fail("unterminated string");
}

function readArray(text: string, i: number): [readonly TomlValue[], number] {
  const items: TomlValue[] = [];
  let j = i + 1;
  const skip = () => {
    while (text[j] === " " || text[j] === "\t") j++;
  };
  for (;;) {
    skip();
    if (j >= text.length) fail("unterminated array");
    if (text[j] === "]") break;
    const [item, next] = readValue(text, j);
    if (Array.isArray(item)) fail("nested arrays aren't supported");
    items.push(item);
    j = next;
    skip();
    if (text[j] === ",") j++;
    else if (text[j] !== "]") fail("expected , or ] in the array");
  }
  if (new Set(items.map((x) => typeof x)).size > 1) fail("arrays must hold one type");
  return [items, j + 1];
}

/** The rest of a line after a value must be blank or a comment. */
function expectEnd(line: string, from: number): void {
  const rest = line.slice(from).trim();
  if (rest !== "" && !rest.startsWith("#")) fail("unexpected text after the value");
}

export function parseToml(text: string): Parsed {
  const root: Record<string, TomlValue> = {};
  const declared = new Set<string>();
  let table = root;
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    try {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("[[")) fail("arrays of tables aren't supported");
      const header = /^\[([^\]]*)\]\s*(#.*)?$/.exec(trimmed);
      if (header !== null) {
        const path = header[1]!.trim().split(".").map((k) => k.trim());
        if (!path.every((k) => BARE_KEY.test(k))) fail("table names must be bare keys joined by dots");
        const name = path.join(".");
        if (declared.has(name)) fail(`duplicate table [${name}]`);
        declared.add(name);
        table = root;
        for (const key of path) {
          const existing = table[key];
          if (existing === undefined) table = (table[key] = {}) as Record<string, TomlValue>;
          else if (typeof existing === "object" && !Array.isArray(existing)) table = existing as Record<string, TomlValue>;
          else fail(`[${name}] redefines key ${key}`);
        }
        continue;
      }
      const eq = line.indexOf("=");
      if (eq < 0) fail("expected key = value or [table]");
      const key = line.slice(0, eq).trim();
      if (!BARE_KEY.test(key)) fail("keys must be bare (letters, digits, _ and -)");
      if (key in table) fail(`duplicate key ${key}`);
      let start = eq + 1;
      while (line[start] === " " || line[start] === "\t") start++;
      const [value, end] = readValue(line, start);
      expectEnd(line, end);
      table[key] = value;
    } catch (error) {
      if (error instanceof TomlError) return { ok: false, error: `line ${n + 1}: ${error.message}` };
      throw error;
    }
  }
  return { ok: true, value: root };
}

const quote = (s: string) => `"${s.replace(/[\\"\n\t\r\b\f]/g, (c) => "\\" + ({ "\n": "n", "\t": "t", "\r": "r", "\b": "b", "\f": "f" }[c] ?? c))}"`;
const isTable = (v: TomlValue): v is TomlTable => typeof v === "object" && !Array.isArray(v);
const scalar = (v: TomlValue): string => (typeof v === "string" ? quote(v) : Array.isArray(v) ? `[${v.map(scalar).join(", ")}]` : String(v));

/** TOML text for a table: its plain keys first, then each subtable under its dotted header. */
export function stringifyToml(value: TomlTable, header = ""): string {
  const plain = Object.entries(value).filter(([, v]) => !isTable(v));
  const tables = Object.entries(value).filter(([, v]) => isTable(v)) as [string, TomlTable][];
  const blocks: string[] = [];
  if (plain.length > 0 || header !== "") blocks.push((header === "" ? "" : `[${header}]\n`) + plain.map(([k, v]) => `${k} = ${scalar(v)}\n`).join(""));
  for (const [k, t] of tables) {
    const name = header === "" ? k : `${header}.${k}`;
    // A table holding only subtables needs no header of its own.
    const inner = Object.values(t).every(isTable) ? stringifyToml(t, "").replace(/^\[/gm, `[${name}.`) : stringifyToml(t, name);
    blocks.push(inner);
  }
  return blocks.filter((b) => b !== "").join("\n");
}
