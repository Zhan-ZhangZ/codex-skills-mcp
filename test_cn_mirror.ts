import { parseConfig } from "./src/config.js";
import { initRemote, fetchManifest, ensureSkillFetched } from "./src/remote/github.js";
import { readFileSync } from "fs";

async function run() {
  const args = ["--cn-mirror"];
  const config = parseConfig(args);
  
  await initRemote(config);
  await fetchManifest(config);
  
  const manifest = JSON.parse(readFileSync(config.manifestPath, "utf-8"));
  const entry = manifest.find((e: any) => e.name === "video-use");
  if (!entry) throw new Error("Skill not found");
  
  await ensureSkillFetched(config, entry);
  console.log("Success!");
}
run().catch(console.error);
