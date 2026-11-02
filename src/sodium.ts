import sodium from "libsodium-wrappers";

// Every crypto call is synchronous after this one await, so importers can
// stay pure functions.
await sodium.ready;

export default sodium;
