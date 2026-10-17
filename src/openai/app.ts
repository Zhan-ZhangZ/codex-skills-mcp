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
import { readSkillDownloadProgress } from "../remote/skill-progress.js";

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
            preferredDisplayMode: "fullscreen",
            availableDisplayModes: ["inline", "fullscreen"],
          },
        },
      },
    ],
  }));

  const initialData = () => {
    void searchEngine.maybeRefreshManifest();
    const categories = searchEngine.getCategories();
    const totalSkills = categories.reduce((s, c) => s + c.skill_count, 0);
    const butler = typeof searchEngine.getButlerEntry === "function"
      ? searchEngine.getButlerEntry()?.name ?? null
      : null;
    return {
      page: "library",
      categories,
      totalSkills,
      butler,
      cache_mode: loader.cacheMode,
      usage: typeof searchEngine.usageSummary === "function"
        ? searchEngine.usageSummary()
        : { total_reads: 0, used_skills: 0, total_failures: 0 },
    };
  };

  const readonly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const appOnly = {
    annotations: readonly,
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
        "Open the on-demand skill library fullscreen from the sidebar. " +
        "Browse categories, search, read instructions, explore files and nested " +
        "sub-skills, inspect cache state, and pick skills for the conversation.",
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
        "library, inspect files and sub-skills, and drop skills into the chat.",
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
        category: z.string().trim().min(1).max(200).optional().describe("Category name to list; omit for the home view"),
      }),
      ...appOnly,
    },
    async ({ category }) => {
      void searchEngine.maybeRefreshManifest();
      if (!category) {
        const categories = searchEngine.getCategories();
        const butler = typeof searchEngine.getButlerEntry === "function"
          ? searchEngine.getButlerEntry()?.name ?? null
          : null;
        const popular = typeof searchEngine.popularSkills === "function"
          ? searchEngine.popularSkills(8)
          : searchEngine.defaultSuggestions(8).map((entry) => ({
              entry,
              reads: 0,
              failures: 0,
              last_read_at: null,
            }));
        return {
          content: [],
          structuredContent: {
            view: "home",
            categories,
            totalSkills: categories.reduce((s, c) => s + c.skill_count, 0),
            butler,
            cache_mode: loader.cacheMode,
            usage: typeof searchEngine.usageSummary === "function"
              ? searchEngine.usageSummary()
              : { total_reads: 0, used_skills: 0, total_failures: 0 },
            top: popular.map(({ entry, reads, failures, last_read_at }) => ({
              name: entry.name,
              description: entry.description,
              cached: loader.isCached(entry),
              reads,
              failures,
              last_used_at: last_read_at,
            })),
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
            category: e.category,
            ...(typeof searchEngine.usageFor === "function"
              ? searchEngine.usageFor(e.name)
              : { reads: 0, failures: 0, last_read_at: null }),
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
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(30).optional(),
        offset: z.number().int().min(0).max(10_000).optional(),
      }),
      ...appOnly,
    },
    async ({ query, limit, offset }) => {
      void searchEngine.maybeRefreshManifest();
      const page = typeof searchEngine.searchWithTotal === "function"
        ? searchEngine.searchWithTotal(query, { limit: limit ?? 20, offset: offset ?? 0 })
        : (() => {
            const results = searchEngine.search(query, { limit: limit ?? 20 });
            return { results, total: results.length };
          })();
      return {
        content: [],
        structuredContent: {
          view: "search",
          query,
          offset: offset ?? 0,
          total: page.total,
          has_more: (offset ?? 0) + page.results.length < page.total,
          results: page.results.map((r) => {
            const entry = searchEngine.findByName(r.name);
            return {
              name: r.name,
              description: r.description,
              category: r.category,
              score: r.score,
              cached: entry ? loader.isCached(entry) : false,
              ...(entry && typeof searchEngine.usageFor === "function"
                ? searchEngine.usageFor(entry.name)
                : { reads: 0, failures: 0, last_read_at: null }),
            };
          }),
        },
      };
    }
  );

  registerAppTool(
    server,
    "skills.progress",
    {
      title: "Read skill materialization progress",
      description: "App-facing: read the latest file-download progress for one skill.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(500),
      }),
      ...appOnly,
    },
    async ({ name }) => ({
      content: [],
      structuredContent: { progress: readSkillDownloadProgress(name) },
    })
  );

  registerAppTool(
    server,
    "skills.clearCache",
    {
      title: "Clear one skill cache",
      description: "App-facing: remove the downloaded files for one skill. Manifest and usage history are preserved.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(500),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] as const } },
    },
    async ({ name }) => {
      const entry = searchEngine.findByName(name);
      if (!entry) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Skill "${name}" not found.` }],
        };
      }
      try {
        const result = await loader.clearCache(entry);
        return {
          content: [],
          structuredContent: {
            ...result,
            name: entry.name,
            cache_mode: loader.cacheMode,
          },
        };
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          }],
        };
      }
    }
  );

  console.error(
    "[codex-skills-mcp] MCP App registered: skills.library (global), " +
      "skills.tray (thread), skills.browse/query/progress/clearCache (app-facing)"
  );
  return true;
}
