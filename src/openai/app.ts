/**
 * MCP App — the ChatGPT-native skill library UI (openai/mcp-extensions spec).
 *
 * Serves the built single-file frontend (dist/app.html, shipped inside the
 * npm package AND the plugin bundle dir) as a `ui://codex-skills/app`
 * resource and registers the sidebar entrypoints per the official Bits &
 * Bolts reference plugin:
 *
 *   - `skills.library`  → global entrypoint (fullscreen browser in the
 *     ChatGPT sidebar; opens with composer + thread layout)
 *   - `skills.tray`     → thread entrypoint (skill panel beside a
 *     conversation)
 *
 * Entrypoint tools return initial `structuredContent` so the App renders its
 * first frame from the tool result without extra round-trips (spec: "MCP Apps
 * SHOULD use the initial tool result for their first render").
 *
 * Graceful degradation: when app.html is absent (older package builds), the
 * resource and entrypoints are simply not registered — every other surface
 * (12 tools, mentions, skill:// resources, settings) keeps working.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

import type { SkillSearchEngine } from "../search/index.js";

const APP_URI = "ui://codex-skills/app";

function loadAppHtml(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // npm package layout: dist/openai/app.js → dist/app.html.
  // Plugin bundle layout: dist/server.js → dist/app.html (same dir).
  for (const p of [resolve(here, "../app.html"), resolve(here, "app.html")]) {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Register the App resource and sidebar entrypoints. Returns true when the
 * App surface was registered (caller can adjust tool-count reporting).
 */
export function registerCodexSkillsApp(
  server: McpServer,
  searchEngine: SkillSearchEngine
): boolean {
  const html = loadAppHtml();
  if (!html) {
    console.error(
      "[codex-skills-mcp] app.html not found next to the server — MCP App " +
        "entrypoints disabled; tools/mentions/resources continue normally."
    );
    return false;
  }

  registerAppResource(server, "codex-skills-app", APP_URI, {}, async () => ({
    contents: [
      {
        uri: APP_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: html,
        _meta: {
          "openai/ui": {
            preferredDisplayMode: "fullscreen",
            availableDisplayModes: ["inline", "fullscreen"],
          },
        },
      },
    ],
  }));

  // Initial frame data for both entrypoints: category tree + totals.
  const initialData = () => {
    const categories = searchEngine.getCategories();
    const totalSkills = categories.reduce((s, c) => s + c.skill_count, 0);
    return {
      page: "library",
      categories,
      totalSkills,
      butler: "00_codex_skills",
    };
  };

  const readonly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  registerAppTool(
    server,
    "skills.library",
    {
      title: "技能库 Codex Skills",
      description:
        "Open the skill library browser (199+ on-demand expert skills, " +
        "15 categories) fullscreen from the sidebar. Search, preview " +
        "SKILL.md, and pick skills for the conversation.",
      annotations: readonly,
      _meta: {
        ui: { resourceUri: APP_URI },
        "openai/ui": { entrypoints: [{ type: "global" }] },
      },
    },
    async () => ({ content: [], structuredContent: initialData() })
  );

  registerAppTool(
    server,
    "skills.tray",
    {
      title: "技能托盘 Skill Tray",
      description:
        "Open a compact skill panel beside this conversation — search the " +
        "library and drop skills into the chat without leaving the thread.",
      annotations: readonly,
      _meta: {
        ui: { resourceUri: APP_URI },
        "openai/ui": { entrypoints: [{ type: "thread" }] },
      },
    },
    async () => ({ content: [], structuredContent: initialData() })
  );

  console.error(
    "[codex-skills-mcp] MCP App registered: skills.library (global), skills.tray (thread)"
  );
  return true;
}
