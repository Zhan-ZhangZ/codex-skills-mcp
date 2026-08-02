import { parseConfig, loadManifest } from "./src/config.js";
import { initRemote, fetchManifest } from "./src/remote/github.js";
import { SkillLoader } from "./src/loader/index.js";
import { SkillSearchEngine } from "./src/search/index.js";

async function main() {
  const args = ["--github-repo", "Zhan-ZhangZ/codexprojec", "--github-branch", "main-lite", "--github-path", "codex-skills"];
  const config = parseConfig(args);
  
  console.log("Initializing remote...");
  await initRemote(config);
  await fetchManifest(config);
  
  console.log("Loading manifest...");
  const manifest = loadManifest(config.manifestPath);
  
  const searchEngine = new SkillSearchEngine(manifest);
  const loader = new SkillLoader(config, manifest);
  
  console.log("Searching for 'video-use' skill...");
  const entry = manifest.find(m => m.name.toLowerCase().includes("video-use"));
  
  if (!entry) {
     console.log("No video skill found. Trying the first skill in manifest.");
     const first = manifest[0];
     if (!first) {
        console.log("Manifest is empty!");
        return;
     }
     await testSkill(loader, first);
  } else {
     await testSkill(loader, entry);
  }
}

async function testSkill(loader: SkillLoader, entry: any) {
  console.log(`Testing lazy remote fetch for skill: ${entry.name} (${entry.relative_path})`);
  const result = await loader.readSkill(entry);
  console.log("=========================================");
  console.log("SUCCESS! Downloaded and parsed skill.");
  console.log(`Dependencies: ${JSON.stringify(result.dependencies)}`);
  console.log(`Instructions snippet: ${result.instructions.substring(0, 150).replace(/\n/g, ' ')}...`);
  console.log("Files downloaded:");
  console.log(JSON.stringify(result.structure.files, null, 2));
}

main().catch(console.error);
