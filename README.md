# @maito/mcp-server

MCP server for [Maito](https://maito.ai) — connect Claude Desktop, Cursor, Zed,
or any MCP client to your Maito workspace (boards, cards, notes, journal).

```bash
npx -y @maito/mcp-server --url https://maito.romankov.dev --token <your-token>
```

Get a token from the Maito web app (Sidebar → **Connect AI**) or from the
mobile MoreView → **Подключить AI** sheet.

## Tools

| Tool | What it does |
|------|--------------|
| `list_spaces` | Returns spaces, boards, columns. |
| `create_card` | Creates a card in a column. |
| `update_card` | Updates fields on an existing card. |
| `archive_card` | Moves card to archive. |
| `search_notes` | Full-text search across notes. |
| `get_note` | Fetches a note by id. |
| `today_plan` | Returns today's overdue + due-today + week-ahead snapshot. |

## Claude Desktop config

Merge into `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "maito": {
      "command": "npx",
      "args": ["-y", "@maito/mcp-server", "--url", "https://maito.romankov.dev", "--token", "<your-token>"]
    }
  }
}
```

Restart Claude Desktop.

## Cursor

Settings → MCP → Add Server, paste the same JSON.

## Self-hosted Maito

Replace `https://maito.romankov.dev` with your URL. The MCP server only needs
`--url` + `--token`; nothing else.

## Develop

```bash
npm install
npm run build
npm test       # spawns server via stdio against a live backend
```

`tests/integration.test.ts` requires `MAITO_URL` env var.

## Security

MCP tokens are JWTs scoped `mcp` with a 10-year TTL. They grant the same
access as your normal login. Don't commit them, don't share them.

## License

AGPL-3.0-only — see [LICENSE](../LICENSE).
