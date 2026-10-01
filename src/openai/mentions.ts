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
  extensions.mentions.setHandler(async ({ query }) => {
    // Reuse the same throttled freshness poll as search_skills so newly
    // integrated skills show up in the typeahead as well.
    if (typeof searchEngine.maybeRefreshManifest === "function") {
      await searchEngine.maybeRefreshManifest();
    }

    const results = searchEngine.search(query, { limit: MENTION_LIMIT });

    return {
      items: results.map((r) => ({
        type: "resource_link" as const,
        uri: `skill://${r.name}`,
        name: r.name,
        title: r.name,
        description: r.description.substring(0, 160),
      })),
    };
  });

  // Resolve skill:// URIs mentioned in the composer. Reading materializes the
  // skill (same code path as read_skill) and serves its SKILL.md.
  server.registerResource(
    "skill",
    new ResourceTemplate("skill://{name}", { list: undefined }),
    {
      description:
        "A codex-skills skill. Reading returns its SKILL.md instructions " +
        "(downloads the complete skill into the local cache on first read).",
      mimeType: "text/markdown",
    },
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

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text: result.instructions,
            },
          ],
        };
      })
  );
}
