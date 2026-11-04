import { getStore } from "@netlify/blobs";
import type { Store } from "./relay.ts";

// Strong consistency: an inbox listing right after a PUT must see it, and the
// chain check reads seq-1 immediately after the sender wrote it.
export function blobsStore(name = "agent-mailbox"): Store {
  const store = getStore({ name, consistency: "strong" });
  return {
    get: async (key) => {
      const data = await store.get(key, { type: "arrayBuffer" });
      return data === null ? null : new Uint8Array(data);
    },
    createOnly: async (key, value) => {
      const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      return (await store.set(key, bytes, { onlyIfNew: true })).modified;
    },
    put: async (key, value) => {
      await store.set(key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    },
    list: async (prefix) => (await store.list({ prefix })).blobs.map((blob) => blob.key),
    // Blobs returns directories as full prefixes; the contract wants the bare
    // child segment. Stripping the prefix and any trailing "/" covers both forms.
    listDirectories: async (prefix) =>
      (await store.list({ prefix, directories: true })).directories.map((dir) => dir.slice(prefix.length).replace(/\/$/, "")),
  };
}
