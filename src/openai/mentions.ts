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

import type { SkillSearchEngine } from "../search/index.js";
import type { SkillLoader } from "../loader/index.js";
import { withToolLogging } from "../lib/logger.js";

/** Max items returned by mention typeahead (picker ergonomics). */
const MENTION_LIMIT = 10;

/**
 * Register the mentions handler and the skill:// resource template.
 */
export function registerOpenAIMentions(
  server: McpServer,
  extensions: OpenAIExtensions,
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

      return {
        items: entries.map((r) => ({
          type: "resource_link" as const,
          uri: `skill://${r.name}`,
          name: r.name,
          title: r.name,
          description: r.description.substring(0, 160),
        })),
      };
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
        // the registry only needs identity. Sorted most-used-first so any
        // host-side truncation keeps the most valuable head.
        resources: searchEngine
          .defaultSuggestions(Number.MAX_SAFE_INTEGER)
          .map((entry) => ({
            uri: `skill://${entry.name}`,
            name: entry.name,
            mimeType: "text/markdown",
          })),
      }),
    }),
    // No template description: the SDK merges it into every resources/list
    // entry (199 × ~50 bytes); omitting keeps the catalog ~5k tokens, safely
    // under the ~12k-token host truncation observed in ChatGPT.
    { mimeType: "text/markdown" },
    async (uri, { name }) =>
      withToolLogging("resources/read skill://", { skill: String(name) }, async () => {
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
