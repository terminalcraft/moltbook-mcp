// Polyfill globalThis.crypto for Node 18 + @noble/curves
import { randomFillSync } from "crypto";
if (!globalThis.crypto?.getRandomValues) {
  globalThis.crypto = { getRandomValues: (buf) => { randomFillSync(buf); return buf; } };
}
