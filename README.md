# AI Subtitles

A Stremio addon that translates English subtitles into your language with your own AI.

- Works with OpenAI, Anthropic (Claude), Google Gemini, Groq, OpenRouter, DeepSeek, Mistral,
  xAI (Grok) or any OpenAI-compatible endpoint.
- 187 languages, the same ones Stremio shows in its subtitle menu.
- Translations aimed at ordinary viewers: technical jargon (police, firefighters, medical, legal)
  is turned into words anyone understands.
- Your API key is stored only inside your install link, encrypted. No accounts.
- Translations are private: each user only gets their own, deleted 24 hours after last use.
- Saves AI calls when a subtitle in your language already exists on OpenSubtitles: nothing is
  translated until you open the AI option, and with **Only when there is no subtitle in my
  language** turned on, the AI option is not even listed for those titles.

## Install

Open the addon's `/configure` page, pick your AI and language, and press **Install in Stremio**.

## Self-hosting

Requires Node.js 20+. No dependencies.

```sh
cp .env.example .env   # set CONFIG_SECRET and PUBLIC_URL
set -a; . ./.env; set +a
node server.js
```

Put it behind HTTPS: Stremio apps only load addons over HTTPS (except on localhost).

### Docker

```sh
docker build -t ai-subtitles .
docker run -d -p 127.0.0.1:7311:7311 \
  -e CONFIG_SECRET="$(openssl rand -hex 32)" \
  -e PUBLIC_URL=https://subtitles.example.com \
  -e REAL_IP_HEADER=x-real-ip \
  -v ai-subtitles-cache:/app/cache \
  ai-subtitles
```

The port is published on localhost only, for a reverse proxy on the same machine. Set
`REAL_IP_HEADER` to the header that proxy writes (see below); without it, every user shares the
proxy's address and one rate limit.

Runs as a non-root user, has a healthcheck on `/health`, and keeps finished translations in
`/app/cache` (mount a volume so they survive updates). Keep `CONFIG_SECRET` the same across
restarts, or every existing install link stops working.

## Running a public instance

Read this before opening your instance to other people.

- **You can read your users' API keys.** Each key travels inside the install link, encrypted with
  `CONFIG_SECRET`. Anyone with that secret and a copy of the link can decrypt it, and reverse-proxy
  access logs store full URLs. Keep the secret private, and strip or hash request paths in your
  proxy logs.
- **Set `REAL_IP_HEADER`.** Behind a reverse proxy, every user otherwise shares one IP and one rate
  limit. Prefer a header your proxy overwrites (`x-real-ip`, `cf-connecting-ip`). With
  `x-forwarded-for`, which proxies append to, the IP is read from the right; set `REAL_IP_HOPS`
  to the number of proxies in front of the app, or users can fake their IP. The header is only
  read from private or loopback addresses; if your proxy reaches the app from a public address,
  list it in `TRUSTED_PROXIES`.
- **The custom provider makes outbound requests to URLs your users choose.** Private and reserved
  addresses, redirects and oversized answers are refused, but set `ALLOW_CUSTOM_PROVIDER=false`
  if you don't want that at all. Don't route outbound traffic through an HTTP proxy
  (`NODE_USE_ENV_PROXY`): the address check would then see the proxy, not the endpoint.
- **Translations are never shared between users.** Each user's translations live in their own
  folder and are deleted `CACHE_TTL_HOURS` after their last use.

| Variable | Default | What it does |
| --- | --- | --- |
| `CONFIG_SECRET` | required | Encrypts install links (32+ chars). Changing it breaks every install. |
| `PUBLIC_URL` | `http://HOST:PORT` | Public HTTPS address, with the path if it lives in a subfolder. |
| `REAL_IP_HEADER` | none | Header with the client IP set by your proxy. |
| `REAL_IP_HOPS` | `1` | How many proxies append to that header; the IP is read that many places from the right. |
| `TRUSTED_PROXIES` | none | Public proxy addresses (IPs or CIDRs, comma-separated) allowed to set that header. |
| `ALLOW_CUSTOM_PROVIDER` | `true` | Offer the custom OpenAI-compatible endpoint. |
| `CACHE_TTL_HOURS` | `24` | Delete a translation this long after its last use. |
| `CACHE_MAX_MB` | `2000` | Disk cap for translations; the least recently used go first. |
| `JOBS_PER_IP_HOUR` | `30` | New translations per IP per hour. |
| `MAX_JOBS` | `10` | Translations running at once (at most 2 per IP, 2 per key and 4 on custom endpoints). |
| `REQS_PER_IP_MIN` | `60` | Per IP per minute: subtitle lists and `/api` calls, and separately subtitle files. |
| `UPSTREAM_PER_MIN` | `300` | Calls to OpenSubtitles and Cinemeta per minute, all users together (10 per IP). |

### BeamUp

```sh
npm install -g beamup-cli
beamup config a.baby-beamup.club <your-github-username>
beamup init ai-subtitles
beamup secrets CONFIG_SECRET "$(openssl rand -hex 32)"
beamup secrets PUBLIC_URL https://<your-project-url>   # printed by the first deploy
beamup secrets REAL_IP_HEADER x-forwarded-for
beamup secrets REAL_IP_HOPS 1   # raise it if BeamUp has more than one proxy in front of the app
beamup
```

BeamUp authenticates you with the public SSH keys of your GitHub account, so the key you deploy
from must be added to GitHub. The disk is reset on every deploy, so the translation cache starts
empty after each update.

## Notice

This addon only translates subtitle text. It does not host, link or stream any video.
Source subtitles come from OpenSubtitles through Stremio's public addon.

## Credits

Language list from [Stremio/nodejs-langs](https://github.com/Stremio/nodejs-langs) (MIT).

## License

[MIT](LICENSE)
