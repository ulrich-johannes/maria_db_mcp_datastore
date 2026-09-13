# datastore-mcp

A remote MCP (Model Context Protocol) server that gives an AI assistant a
persistent key/value state store backed by MariaDB. Deployed as a container
on [Fly.io](https://fly.io), authenticated via OAuth 2.1.

## What it stores

A single table (name configurable via `DB_TABLE`) with columns:

| column         | meaning                                   |
|----------------|--------------------------------------------|
| `var_name`     | primary key / variable name                |
| `description`  | short human-readable description           |
| `content`      | the value (LONGTEXT — can be very long)    |
| `created`      | row creation timestamp                     |
| `last_updated` | auto-updated on every change                |
| `deleted`      | soft-delete flag                            |

The server creates this table automatically on startup if it doesn't exist
(see [`migrations/001_init.sql`](migrations/001_init.sql) for the equivalent
manual DDL).

## MCP tools exposed

- `state_create(var_name, description?, content?)` — create a new variable; fails if it already exists (unless it was soft-deleted, in which case it's revived).
- `state_get(var_name)` — read a variable's full record.
- `state_update(var_name, description?, content?)` — update an existing variable; omitted fields are left unchanged.
- `state_delete(var_name)` — soft-delete a variable (sets `deleted = 1`).
- `state_list(include_deleted?)` — list `var_name` + `description` for all (non-deleted, by default) variables.

## Authentication

The MCP endpoint (`/mcp`) requires an OAuth 2.1 Bearer token, obtained via a
standard authorization-code + PKCE flow with dynamic client registration —
the flow modern MCP clients (Claude.ai, Claude Code, etc.) already speak.
There is a single set of credentials (`OAUTH_USERNAME` / `OAUTH_PASSWORD`)
gating the login screen shown during that flow — enter them once when your
MCP client connects.

**Limitations to be aware of (fine for a personal/single-user tool, not for
multi-tenant use):**
- Tokens and pending logins are kept in memory, not persisted — they're lost
  on redeploy/restart, so the app is configured to keep at least one machine
  always running (see `fly.toml`) rather than scale-to-zero.
- Refresh tokens aren't implemented; when an access token expires (1 hour)
  the client re-runs the OAuth flow, which just means logging in again.
- Dynamic client registration is open (any client can register itself), same
  as most MCP OAuth reference implementations — the actual gate is the
  username/password login screen.

## Local development

```bash
cp .env.example .env   # fill in your local MariaDB + a login/password
npm install
npm run dev
```

## Environment variables

See [`.env.example`](.env.example) for the full list:

- `PUBLIC_URL` — externally reachable base URL (used to build OAuth issuer/redirect URLs). Must be `https://` in production (an `http://localhost` exemption exists for local dev).
- `PORT` — HTTP port to listen on.
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_TABLE`, `DB_SSL` — MariaDB connection.
- `OAUTH_USERNAME`, `OAUTH_PASSWORD` — credentials for the OAuth login screen.

## Deploying to Fly.io

1. **Create the Fly app** (one-time, from your machine):
   ```bash
   fly apps create <your-app-name>
   ```
   Update the `app = "..."` line in [`fly.toml`](fly.toml) to match.

   Then allocate a public IP so `<your-app-name>.fly.dev` actually resolves —
   this isn't something `fly.toml` can declare, it's a one-time action against
   the app itself:
   ```bash
   fly ips allocate-v6 -a <your-app-name>
   fly ips allocate-v4 --shared -a <your-app-name>
   ```
   (`fly launch` usually does this automatically; `fly apps create` alone does
   not — if you skip this, the hostname returns `NXDOMAIN`/no DNS record and
   the service is unreachable even though it's running fine.)

2. **Set secrets** (never commit these — use `fly secrets`, not `[env]` in `fly.toml`):
   ```bash
   fly secrets set \
     PUBLIC_URL=https://<your-app-name>.fly.dev \
     DB_HOST=... DB_PORT=3306 DB_USER=... DB_PASSWORD=... DB_NAME=... DB_TABLE=mcp_state \
     DB_SSL=true \
     OAUTH_USERNAME=... OAUTH_PASSWORD=...
   ```
   Your MariaDB instance needs to be reachable from Fly.io's network (a public
   host with firewall rules allowing Fly's egress IPs, or a private
   connection such as a Fly.io WireGuard peer / Tailscale, depending on where
   it's hosted).

3. **Deploy on push to `main`.** This repo is wired to Fly.io's GitHub
   integration (set up via `fly launch`'s GitHub connection), which builds
   and deploys automatically on push — there's no `.github/workflows/*.yml`
   in this repo driving it. If you'd rather drive deploys from a GitHub
   Actions workflow instead, create `.github/workflows/deploy.yml` running
   `flyctl deploy --remote-only` on push, authenticated with a repo secret
   `FLY_API_TOKEN` from `fly tokens create deploy -x 999999h` — just don't run
   both mechanisms at once, or you'll get duplicate/competing deploys.

## Connecting an AI client

Point your MCP client at `https://<your-app-name>.fly.dev/mcp`. The client
will discover the OAuth metadata automatically, register itself, and prompt
you to log in with `OAUTH_USERNAME` / `OAUTH_PASSWORD` the first time.
