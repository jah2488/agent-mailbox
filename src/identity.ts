import { createHash } from "node:crypto";
import sodium from "./sodium.ts";

/**
 * A person's address: the first 16 base32 chars of sha256(signing public key).
 * Branded so only pidOf can mint one; a hash or free text won't type-check.
 */
export type Pid = string & { readonly __brand: "Pid" };

export type Peer = { readonly pid: Pid; readonly signPub: Uint8Array; readonly boxPub: Uint8Array };

export type Identity = Peer & { readonly signSec: Uint8Array; readonly boxSec: Uint8Array };

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let out = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(buffer >> bits) & 31];
    }
  }
  return bits > 0 ? out + BASE32[(buffer << (5 - bits)) & 31] : out;
}

export function pidOf(signPub: Uint8Array): Pid {
  return base32(createHash("sha256").update(signPub).digest()).slice(0, 16) as Pid;
}

// Two keypairs: reusing one key across signing and encryption couples the
// security of both primitives, and libsodium's conversion path is discouraged.
export function generateIdentity(): Identity {
  const sign = sodium.crypto_sign_keypair();
  const box = sodium.crypto_box_keypair();
  return {
    pid: pidOf(sign.publicKey),
    signPub: sign.publicKey,
    signSec: sign.privateKey,
    boxPub: box.publicKey,
    boxSec: box.privateKey,
  };
}

export function toPeer({ pid, signPub, boxPub }: Identity): Peer {
  return { pid, signPub, boxPub };
}
