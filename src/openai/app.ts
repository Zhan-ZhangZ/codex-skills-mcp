/**
 * MCP App — the ChatGPT-native skill library UI (openai/mcp-extensions spec).
 *
 * Serves the built single-file frontend (dist/app.html, shipped inside the
 * npm package AND the plugin bundle dir) as a `ui://codex-skills/app`
 * resource and registers the sidebar entrypoints per the official Bits &
 * Bolts reference plugin:
 *
 *   - `skills.library`  → global entrypoint (fullscreen browser in the
 *     ChatGPT sidebar), with an inline data-URI icon per spec icon rules
 *   - `skills.tray`     → thread entrypoint (skill panel beside a chat)
 *
 * App-facing structured tools (visibility ["app"] — hidden from the model,
 * called by the frontend via transport):
 *   - `skills.browse` {category?} → home (categories + usage-top) or a
 *     category listing, every skill carrying a cached flag
 *   - `skills.query`  {query}     → BM25 search results for the app's
 *     search box
 *
 * Graceful degradation: when app.html is absent, everything above is simply
 * not registered — the 12 base tools, mentions and skill:// resources keep
 * working unchanged.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

import type { SkillSearchEngine } from "../search/index.js";
import type { SkillLoader } from "../loader/index.js";

const APP_URI = "ui://codex-skills/app";

/** 20×20 currentColor monochrome grid, per the spec's sidebar icon rules. */
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="11" y="3" width="6" height="6" rx="1"/><rect x="3" y="11" width="6" height="6" rx="1"/><rect x="11" y="11" width="6" height="6" rx="1"/></svg>';
const ICON = {
  src: "data:image/svg+xml," + encodeURIComponent(ICON_SVG),
  mimeType: "image/svg+xml",
  sizes: ["any"],
};

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

export function registerCodexSkillsApp(
  server: McpServer,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
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
            // Inline-first: opening from a conversation renders in the
            // right-side panel (thread context) instead of a new fullscreen
            // page; fullscreen stays available via the expand control.
            preferredDisplayMode: "inline",
            availableDisplayModes: ["inline", "fullscreen"],
          },
        },
      },
    ],
  }));

  const initialData = () => {
    const categories = searchEngine.getCategories();
    const totalSkills = categories.reduce((s, c) => s + c.skill_count, 0);
    return { page: "library", categories, totalSkills, butler: "00_codex_skills" };
  };

  const readonly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const appOnly = {
    ...readonly,
    _meta: { ui: { visibility: ["app"] as const } },
  };
  const ui = (entrypoints: Array<Record<string, unknown>>) => ({
    ui: { resourceUri: APP_URI },
    "openai/ui": { entrypoints },
    "openai/iconStyle": "monochrome",
  });

  registerAppTool(
    server,
    "skills.library",
    {
      title: "技能库 Codex Skills",
      description:
        "Open the skill library browser (199+ on-demand expert skills, 15 " +
        "categories) fullscreen from the sidebar. Search, preview SKILL.md, " +
        "and pick skills for the conversation.",
      annotations: readonly,
      _meta: { ...ui([{ type: "global" }]), icons: [ICON] },
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
      _meta: { ...ui([{ type: "thread" }]), icons: [ICON] },
    },
    async () => ({ content: [], structuredContent: initialData() })
  );

  // ---- App-facing structured tools (frontend-only) ----------------------

  registerAppTool(
    server,
    "skills.browse",
    {
      title: "Browse skill library",
      description: "App-facing: category overview or a category's skill list.",
      inputSchema: z.object({
        category: z.string().optional().describe("Category name to list; omit for the home view"),
      }),
      ...appOnly,
    },
    async ({ category }) => {
      if (!category) {
        const categories = searchEngine.getCategories();
        return {
          content: [],
          structuredContent: {
            view: "home",
            categories,
            totalSkills: categories.reduce((s, c) => s + c.skill_count, 0),
            top: searchEngine
              .defaultSuggestions(8)
              .map((e) => ({ name: e.name, description: e.description, cached: loader.isCached(e) })),
          },
        };
      }
      const all = searchEngine.allSkills().filter((e) => e.category === category);
      return {
        content: [],
        structuredContent: {
          view: "category",
          category,
          skills: all.map((e) => ({
            name: e.name,
            description: e.description,
            cached: loader.isCached(e),
          })),
        },
      };
    }
  );

  registerAppTool(
    server,
    "skills.query",
    {
      title: "Search skill library",
      description: "App-facing: BM25 search over name/aliases/keywords/description.",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(30).optional(),
      }),
      ...appOnly,
    },
    async ({ query, limit }) => {
      const results = searchEngine.search(query, { limit: limit ?? 20 });
      return {
        content: [],
        structuredContent: {
          view: "search",
          query,
          results: results.map((r) => {
            const entry = searchEngine.findByName(r.name);
            return {
              name: r.name,
              description: r.description,
              category: r.category,
              score: r.score,
              cached: entry ? loader.isCached(entry) : false,
            };
          }),
        },
      };
    }
  );

  console.error(
    "[codex-skills-mcp] MCP App registered: skills.library (global), " +
      "skills.tray (thread), skills.browse/query (app-facing)"
  );
  return true;
}
