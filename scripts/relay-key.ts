// Makes a relay's signing key. Prints the secret seed for MAILBOX_RELAY_KEY
// and the public key clients will pin. Run: npm run relay-key
import { newRelaySeed, relayKeyFromSeed } from "../src/relay-identity.ts";

const seed = newRelaySeed();
console.log(`MAILBOX_RELAY_KEY=${seed}`);
console.log(`public key (clients pin this): ${relayKeyFromSeed(seed).publicKey}`);
console.log("Keep the seed secret: set it as a secret environment variable on the relay, and nowhere else.");
