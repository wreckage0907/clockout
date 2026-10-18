import { build } from "tsdown";

// e2e tests run the real bundle, so build it once before any test file loads.
export default async function setup() {
  await build({ logLevel: "silent" });
}
