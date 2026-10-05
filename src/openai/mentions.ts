/**
 * OpenAI MCP Extensions — Composer At-Mentions
 *
 * Implements the `mentions/search` extension from
 * https://github.com/openai/mcp-extensions (spec §Composer At-Mentions) using
 * the official `@openai/mcp-extensions` SDK helper.
 *
 * What it adds:
 *   - A `search_mentions` tool advertised via
 *     `_meta["openai/extensions"]["mentions/search"]` with app-only visibility.
 *     In ChatGPT, users can @-mention the plugin and typeahead-search skills
 *     directly in the composer; picked items become composer references.
 *   - A `skill://{name}` MCP resource (read via `resources/read`) so those
 *     references resolve to the skill's SKILL.md when the message is sent.
 *     This also lays groundwork for the official
 *     `io.modelcontextprotocol/skills` MCP extension later.
 *
 * Non-ChatGPT hosts see `search_mentions` as an ordinary read-only tool and
 * the skill:// resources as a normal resource template.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenAIExtensions } from "@openai/mcp-extensions/server";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "../config.js";
import type { SkillSearchEngine } from "../search/index.js";
import type { SkillLoader } from "../loader/index.js";
import { withToolLogging } from "../lib/logger.js";

/** Max items returned by mention typeahead (picker ergonomics). */
const MENTION_LIMIT = 10;

/** The butler (Librarian Router) skill — the fixed entrance to the library. */
const BUTLER_NAME = "00_codex_skills";

/**
 * Load the butler's root SKILL.md as a SINGLE FILE. The butler's
 * relative_path is "./" (the repository root), so materializing it as a
 * regular skill would download the entire library — instead we serve only
 * the root SKILL.md: from the skills dir when present, otherwise a one-file
 * remote fetch that is cached for subsequent reads.
 */
async function loadButlerSkillMd(config: Config): Promise<string> {
  const cached = join(config.skillsDir, "SKILL.md");
  if (existsSync(cached)) {
    return readFileSync(cached, "utf-8");
  }
  if (!config.isRemote) {
    throw new Error(
      "Butler SKILL.md not found next to skills_manifest.json (local mode expects a repository checkout)."
    );
  }
  const { fetchRootSkillMd } = await import("../remote/github.js");
  const text = await fetchRootSkillMd(config);
  try {
    writeFileSync(cached, text, "utf-8");
  } catch {
    // Cache write is best-effort; serving the text matters more.
  }
  return text;
}

/**
 * Register the mentions handler and the skill:// resource template.
 */
export function registerOpenAIMentions(
  server: McpServer,
  extensions: OpenAIExtensions,
  config: Config,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
): void {
  extensions.mentions.setHandler(async ({ query }) =>
    withToolLogging("search_mentions", { query }, async () => {
      // Reuse the same throttled freshness poll as search_skills so newly
      // integrated skills show up in the typeahead as well.
      if (typeof searchEngine.maybeRefreshManifest === "function") {
        await searchEngine.maybeRefreshManifest();
      }

      // The spec allows an empty query: the picker opens before the user
      // types. Return default suggestions (most-used, then freshest) instead
      // of an empty list so the mention target is never blank.
      const entries: { name: string; description: string }[] = query.trim()
        ? searchEngine.search(query, { limit: MENTION_LIMIT })
        : searchEngine.defaultSuggestions(MENTION_LIMIT);

      // The butler is PINNED as the first item on every typeahead response:
      // it is the library entrance (Librarian Router), independent of what
      // the user is typing. Regular results follow unchanged.
      const butler = searchEngine.getButlerEntry();
      const items: {
        type: "resource_link";
        uri: string;
        name: string;
        title: string;
        description?: string;
      }[] = [];
      if (butler) {
        items.push({
          type: "resource_link",
          uri: `skill://${butler.name}`,
          name: butler.name,
          title: `管家 · ${butler.name}`,
          description: `【固定入口】${butler.description}`.substring(0, 180),
        });
      }
      for (const r of entries) {
        items.push({
          type: "resource_link",
          uri: `skill://${r.name}`,
          name: r.name,
          title: r.name,
          description: r.description.substring(0, 160),
        });
      }

      return { items };
    })
  );

  // Supporting files within a skill (README.md, scripts/, references/...).
  // Hosts/models naturally probe sub-paths like skill://<name>/README.md
  // after reading a mention's SKILL.md; without this template those probes
  // 404'd (-32602 "Resource not found"). {+path} spans nested directories.
  server.registerResource(
    "skill-file",
    new ResourceTemplate("skill://{name}/{+path}", { list: undefined }),
    {
      description:
        "A supporting file inside a codex-skills skill directory (README.md, " +
        "scripts, configs, references). Reading materializes the skill if needed.",
      mimeType: "text/plain",
    },
    async (uri, { name, path }) =>
      withToolLogging("resources/read skill-file://", { skill: String(name), file: String(path) }, async () => {
        const entry = searchEngine.findByName(String(name));
        if (!entry) {
          throw new Error(`Skill "${name}" not found.`);
        }
        // loadSkillFile handles remote fetch, path-traversal security and
        // missing-file errors with clear messages.
        const { content, size_bytes } = await loader.loadSkillFile(entry, String(path));
        const mime = String(path).endsWith(".md")
          ? "text/markdown"
          : String(path).endsWith(".json")
            ? "application/json"
            : "text/plain";
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: mime,
              text: `## ${name} / ${path} (${size_bytes} bytes)\n\n${content}`,
            },
          ],
        };
      })
  );

  // Resolve skill:// URIs mentioned in the composer. Reading materializes the
  // skill (same code path as read_skill) and serves its SKILL.md.
  server.registerResource(
    "skill",
    new ResourceTemplate("skill://{name}", {
      // The host's resource registry (and therefore @-mention reference
      // resolution, e.g. mcp-resource://<server>/skill://<name> links) is
      // built from resources/list — returning an empty list made mentioned
      // skills unreadable in ChatGPT ("not in the available skills list").
      list: async () => ({
        // Deliberately description-free: hosts build their resource registry
        // from this list and model-side enumeration output gets truncated
        // around ~12k tokens with descriptions included (observed in
        // ChatGPT). Details live in search_mentions items and resources/read;
        // the registry only needs identity. The butler is pinned first as
        // the library entrance, then skills sorted most-used-first.
        resources: [
          ...(searchEngine.getButlerEntry()
            ? [
                {
                  uri: `skill://${BUTLER_NAME}`,
                  name: BUTLER_NAME,
                  mimeType: "text/markdown",
                },
              ]
            : []),
          ...searchEngine
            .defaultSuggestions(Number.MAX_SAFE_INTEGER)
            .map((entry) => ({
              uri: `skill://${entry.name}`,
              name: entry.name,
              mimeType: "text/markdown",
            })),
        ],
      }),
    }),
    // No template description: the SDK merges it into every resources/list
    // entry (199 × ~50 bytes); omitting keeps the catalog ~5k tokens, safely
    // under the ~12k-token host truncation observed in ChatGPT.
    { mimeType: "text/markdown" },
    async (uri, { name }) =>
      withToolLogging("resources/read skill://", { skill: String(name) }, async () => {
        // The butler lives at the repository root: serve its single SKILL.md
        // instead of materializing the entire library as one "skill".
        if (String(name) === BUTLER_NAME) {
          const butler = searchEngine.getButlerEntry();
          if (!butler) {
            throw new Error("Butler skill (00_codex_skills) missing from manifest.");
          }
          const text = await loadButlerSkillMd(config);
          // Host-compatibility note: the butler's gates were written for
          // filesystem hosts (view_file / reading skills_manifest.json). In
          // MCP hosts this teaches it the resource path, so UNCACHED skills
          // routed by Gate 2/3 auto-materialize instead of failing on a
          // shell cat of a nonexistent local file.
          const note =
            "\n\n---\n\n" +
            "> 🔌 **MCP host note** (appended by the codex-skills server):\n" +
            "> - Read ANY skill — cached or not — via `resources/read skill://<name>`; " +
            "first read auto-downloads (materializes) the complete skill. " +
            "Supporting files: `skill://<name>/<relative-path>`.\n" +
            "> - Prefer `search_skills` / `search_mentions` over reading " +
            "skills_manifest.json directly: same index, BM25-ranked, Chinese-friendly.\n" +
            "> - Local cache root when shell access is available: `~/.codex-skills-cache/`.\n";
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "text/markdown",
                text: text + note,
              },
            ],
          };
        }

        let entry = searchEngine.findByName(String(name));
        if (!entry) {
          if (typeof searchEngine.maybeRefreshManifest === "function") {
            await searchEngine.maybeRefreshManifest();
            entry = searchEngine.findByName(String(name));
          }
        }
        if (!entry) {
          throw new Error(
            `Skill "${name}" not found. Search via the search_mentions tool or search_skills.`
          );
        }

        const result = await loader.readSkill(entry);
        if (typeof searchEngine.recordUsage === "function") {
          searchEngine.recordUsage(entry.name);
        }

        // Self-describing hint so models reading this resource know where
        // supporting files live (they otherwise probe sub-paths blind).
        const hint =
          `\n\n---\n> 📁 Supporting files for this skill (README.md, scripts/, ` +
          `references/, ...) are readable as MCP resources: ` +
          "`skill://" + entry.name + "/<relative-path>`.";

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text: result.instructions + hint,
            },
          ],
        };
      })
  );
}
