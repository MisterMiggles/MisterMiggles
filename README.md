# MisterMiggles Hub

A self-hosted landing page for everything running on the server: media, security,
home automation, apps and infrastructure. Each service shows a live status dot,
and a built-in AI agent ("Miggles") can check what's up, find services and read
server load from a chat panel.

- **One YAML file** lists your services (`config/services.yaml`). Edits apply on refresh.
- **Live status** comes from server-side pings over your LAN or Docker network, so checks never go through Cloudflare.
- **Routing badges** show whether each service goes through Cloudflare, NPM or LAN only.
- **AI agent** runs on Claude through the Anthropic API. Its tools are read-only: list services, check status, read host stats.
- Search (press `/`), category filters, dark and light mode, and a mobile layout.

## Quick start (Docker + Nginx Proxy Manager)

```bash
git clone https://github.com/MisterMiggles/MisterMiggles.git hub && cd hub
cp config/services.example.yaml config/services.yaml   # then edit it
cp .env.example .env                                   # add ANTHROPIC_API_KEY
docker network ls                                      # find NPM's network, set PROXY_NETWORK in .env
docker compose up -d --build
```

In Nginx Proxy Manager, add a **Proxy Host**:

| Field | Value |
|---|---|
| Domain | `hub.yourdomain.com` |
| Scheme / Forward host / Port | `http` / `mistermiggles-hub` / `3000` |
| Websockets support | on |
| SSL | Request a Let's Encrypt cert (or a Cloudflare Origin cert), Force SSL, HTTP/2 |

So that the agent's replies stream instead of arriving all at once, add this
under **Advanced → Custom Nginx configuration**:

```nginx
proxy_buffering off;
proxy_read_timeout 300s;
```

The app also sends `X-Accel-Buffering: no`, so this is a belt-and-braces setting.

## Cloudflare

Pick one of these:

1. **Proxied DNS → NPM.** Point an orange-cloud `A`/`CNAME` record for `hub` at your
   home IP. Set SSL/TLS mode to **Full (strict)**, and give NPM either a Let's
   Encrypt cert (DNS challenge with a Cloudflare API token) or a Cloudflare Origin cert.
2. **Cloudflare Tunnel.** In `cloudflared`, route `hub.yourdomain.com` to
   `http://mistermiggles-hub:3000`, or to NPM if you want NPM to stay the single entry point.

### Lock it down (strongly recommended)

The dashboard shows your internal layout, and the agent spends API credit, so
don't leave it open to the internet:

- **Cloudflare Access** (Zero Trust → Access → Applications). Add a self-hosted
  app for `hub.yourdomain.com` with a policy that allows only your email. The hub
  shows the signed-in email in the header.
  - If the hub is reachable **only** through Cloudflare (a Tunnel, or a firewall
    that allows only Cloudflare IPs), also set `REQUIRE_CF_ACCESS=true`. The app
    will then reject any request that arrives without Access's identity header.
- **Or an NPM Access List.** Use basic auth or allow LAN IPs only, and attach it
  to the proxy host.

## Configuring services

See `config/services.example.yaml` for every option. Example entry:

```yaml
categories:
  - name: Media
    icon: "🎬"
    services:
      - name: Jellyfin
        url: https://jellyfin.yourdomain.com      # what you click
        check: http://192.168.1.10:8096/health    # what the hub pings (LAN/Docker address)
        icon: https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/jellyfin.svg
        description: Movies and TV
        via: cloudflare                           # cloudflare | npm | tunnel | lan
```

How status is reported:

- **up**: the app answered with any status below 500. A 401 or 403 still counts,
  because the app is running and just wants you to log in.
- **degraded**: the app answered with a 5xx.
- **down**: timeout, refused connection or DNS failure.
- `insecure: true` skips TLS verification. Use it for self-signed internal endpoints like Portainer on `:9443`.
- `check: false` turns off the status dot, which suits external links.

Use internal addresses for `check`. A check through Cloudflare Access gets the
Access login page back, so a dead app would still show as "up". Container names
work too, e.g. `http://jellyfin:8096`, as long as the hub shares a Docker network with that container.

The icon set at [homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons) covers
nearly every self-hosted app. Plain emoji also work as icons.

## The AI agent

Set `ANTHROPIC_API_KEY` in `.env` (get a key from https://console.anthropic.com).
Without a key the chat button stays hidden and the dashboard works as normal.

- Model: `claude-opus-5-5` by default. You can override it with `AGENT_MODEL`.
- `AGENT_EFFORT` sets how hard it thinks: `low` is cheapest and fastest, `medium` is the default, and `high` and above suit more complex questions.
- **Refusal fallback is on.** If a request is declined by Claude's safety classifiers, the API re-runs it on Anthropic's recommended fallback model (`fallbacks: "default"`). To turn this off, remove the `fallbacks` and `betas` lines in `server/agent.js`.
- Conversations are kept in memory on the server and disappear on restart. The **New** button starts over.

Tools the agent can call (all read-only):

| Tool | What it does |
|---|---|
| `list_services` | Reads the service catalog, optionally filtered by category |
| `check_services` | Pings some or all services: state, HTTP code, latency |
| `server_stats` | Host uptime, load, memory, root disk |

To give the agent more reach, add a tool in `server/agent.js`: a JSON schema in
`tools`, a zod schema in `schemas`, and a function in `handlers`. Good next
steps would be Home Assistant entity states (`GET /api/states` with a long-lived
token), Docker container status from a read-only socket proxy, or the NPM API's
proxy-host and cert-expiry list. Keep new tools read-only unless you really want
the agent to make changes.

## Running without Docker

```bash
npm install
cp config/services.example.yaml config/services.yaml
ANTHROPIC_API_KEY=sk-ant-... npm start     # http://localhost:3000
```

Requires Node 20 or newer.

## Layout

```
server/index.js    HTTP server: static files, /api/config, /api/status, /api/agent/*
server/config.js   Loads services.yaml and strips internal URLs before they reach the browser
server/status.js   Health checks (cached 20 s)
server/agent.js    Claude agent loop and tools
public/            Dashboard UI (no build step)
config/            Service catalog
```
