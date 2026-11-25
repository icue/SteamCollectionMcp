# Steam Collection MCP

A read-only MCP server that looks up Steam games and checks the configured account’s library and wishlist. It uses stdio and reads live Steam data on each call.

## Quick Start

### Requirements

- Node.js 22.12.0 or later and npm ([download Node.js](https://nodejs.org/))
- A Steam Web API key and your 17-digit SteamID64. Your game details and wishlist must be visible to the API. [Get an API key](https://steamcommunity.com/dev/apikey) · [Find your SteamID64](https://help.steampowered.com/en/faqs/view/2816-BE67-5B69-0FEC)

### Install from npm

Add the following to your MCP client's configuration, replacing the two credential placeholders, then restart the client. No repository clone, manual build, or global installation is required.

```json
{
  "mcpServers": {
    "steam-collection": {
      "command": "npx",
      "args": ["-y", "steam-collection-mcp"],
      "env": {
        "STEAM_API_KEY": "your_api_key",
        "STEAM_ID": "your_17_digit_steamid64"
      }
    }
  }
}
```

This format works with Claude Desktop and other compatible JSON-based MCP clients. In Cursor, use `.cursor/mcp.json`; in Claude Desktop, use Settings > Developer > Edit Config.

For Codex, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.steam-collection]
command = "npx"
args = ["-y", "steam-collection-mcp"]

[mcp_servers.steam-collection.env]
STEAM_API_KEY = "your_api_key"
STEAM_ID = "your_17_digit_steamid64"
```

Your MCP client launches the server locally. Steam requests originate from your machine; no project-hosted proxy or server is required. Keep your Steam API key in your local client configuration, and do not commit it to GitHub or share it.

### Install from source

Clone the repository, then install and build:

```sh
git clone https://github.com/icue/SteamCollectionMcp.git
cd SteamCollectionMcp
npm ci
npm run build
```

In the client configuration above, change `command` to `node` and `args` to `["/absolute/path/to/SteamCollectionMcp/dist/index.js"]`. Keep the same environment variables.

### Optional configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `STEAM_LANGUAGE` | `english` | Default Steam language code or BCP 47 tag |
| `STEAM_COUNTRY` | `US` | Two-letter Steam Store region |
| `STEAM_HTTP_TIMEOUT_MS` | `10000` | Timeout for one HTTP request in milliseconds |
| `STEAM_TOOL_TIMEOUT_MS` | `90000` | Deadline for a tool call in milliseconds |
| `STEAM_MAX_CONCURRENCY` | `2` | Maximum concurrent HTTP requests |
| `STEAM_METADATA_BATCH_SIZE` | `50` | Number of AppIDs per metadata request |

## Tools

| Tool | Purpose |
| --- | --- |
| `list_owned_games` | List owned games in AppID order |
| `list_wishlist_games` | List the public wishlist in priority order |
| `resolve_game` | Identify a game by title, AppID, or Steam Store app URL |
| `get_game_status` | Check ownership and wishlist status for one game |
| `get_games_status` | Check up to 50 games in one call, preserving the input order and original query strings |

The list tools use `offset` (default `0`) and `limit` (default `100`, maximum `500`). Set `include_metadata` to `false` to skip store metadata. Each page is read live, so use AppIDs to deduplicate results across pages if the collection changes.

Use `language` and `alternative_names` to help resolve localized titles. Ambiguous titles return candidates. If identity is unresolved or a Steam source is unavailable, affected ownership or wishlist values are `null`.

## Development

```sh
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

For real-account checks, set `STEAM_API_KEY` and `STEAM_ID` and run `npm run test:live`. The large-library check requires at least 2,000 games visible to the API.

For the optional wishlist refresh check, set `STEAM_LIVE_MUTATION_APPID` and `STEAM_LIVE_MUTATION_EXPECT` (`add` or `remove`). Make the change on Steam after `Read 1 verified` appears. `STEAM_LIVE_MUTATION_WAIT_MS` defaults to 30,000 ms.


## Releasing (maintainers)

After the first npm publication and one-time [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) setup, publish a stable GitHub Release with a tag matching the version in `package.json` (for example, `v1.0.1`). The `publish.yml` workflow builds, runs the offline tests, and publishes to npm using OIDC without a stored npm token.

Bump and commit the package version (including the lockfile) before creating each release. For example:

```sh
npm version patch
git push origin main --follow-tags
```

Then [create a GitHub Release](https://github.com/icue/SteamCollectionMcp/releases/new) for the new tag. Pre-releases do not publish to the default npm channel.

## License

Licensed under the BSD 3-Clause License. [LICENSE](LICENSE)
