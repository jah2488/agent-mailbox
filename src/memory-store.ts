import type { Store } from "./relay.ts";

export type MemoryStore = Store & { readonly listed: string[]; readonly keys: () => readonly string[] };

/**
 * An in-memory relay Store for tests and local experiments. The Store
 * contract promises no listing order, so listings come back reversed on
 * purpose: anything that relies on order has to sort for itself.
 */
export function memoryStore(): MemoryStore {
  const data = new Map<string, Uint8Array<ArrayBuffer>>();
  const listed: string[] = [];
  return {
    listed,
    keys: () => [...data.keys()],
    get: async (key) => data.get(key) ?? null,
    createOnly: async (key, value) => {
      if (data.has(key)) return false;
      data.set(key, value);
      return true;
    },
    list: async (prefix) => {
      listed.push(prefix);
      return [...data.keys()].filter((k) => k.startsWith(prefix)).sort().reverse();
    },
    listDirectories: async (prefix) => {
      const children = [...data.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/"));
      return [...new Set(children.filter((parts) => parts.length > 1).map((parts) => parts[0]!))].sort().reverse();
    },
  };
}
