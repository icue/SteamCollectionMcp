# Steam Collection MCP

A read-only MCP server that looks up Steam games and checks the configured account’s library and wishlist. It uses stdio and reads live Steam data on each call.

## Setup

- Node.js 22.12.0 or later
- A Steam Web API key and the account’s 17-digit SteamID64. The account’s game details and wishlist must be visible to the API. [Get an API key](https://steamcommunity.com/dev/apikey) · [Find your SteamID64](https://help.steampowered.com/en/faqs/view/2816-BE67-5B69-0FEC)

From the repository, install dependencies and build the server.

```sh
npm ci
npm run build
```

Add the server to your MCP client’s configuration and replace the path and credentials.

```json
{
  "mcpServers": {
    "steam-collection": {
      "command": "node",
      "args": ["/absolute/path/to/steam-collection-mcp/dist/index.js"],
      "env": {
        "STEAM_API_KEY": "your_api_key",
        "STEAM_ID": "your_17_digit_steamid64"
      }
    }
  }
}
```

To run an npm release, use `"command": "npx"` and `"args": ["-y", "steam-collection-mcp"]` with the same environment variables.

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

The implementation specification covers endpoint behavior and the acceptance criteria. [Implementation specification](steam-collection-mcp-implementation.md)

## License

Licensed under the BSD 3-Clause License. [LICENSE](LICENSE)
