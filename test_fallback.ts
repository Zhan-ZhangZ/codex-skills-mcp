import { parseConfig } from "./src/config.js";
import { initRemote, fetchManifest } from "./src/remote/github.js";

// Mock global fetch to simulate a completely dead network (no VPN, no mirrors work)
const originalFetch = global.fetch;
global.fetch = async (url: string | Request | URL, options?: RequestInit) => {
  throw new Error(`fetch failed: ENOTFOUND ${url}`);
};

async function run() {
  const config = parseConfig(["--cn-mirror"]);
  await initRemote(config);
  
  try {
    console.log("Attempting to fetch manifest with completely dead network...");
    await fetchManifest(config);
    console.log("❌ Should not reach here!");
  } catch (error: any) {
    console.log("✅ Caught expected error:");
    console.log("-----------------------------------------");
    console.log(error.message);
    console.log("-----------------------------------------");
  }
}

run().catch(console.error).finally(() => {
  global.fetch = originalFetch;
});
