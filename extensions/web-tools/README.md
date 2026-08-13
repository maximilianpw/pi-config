# web-tools

Pi extension that registers `webfetch` for fetching a public URL as Markdown,
text, raw HTML, or an inline raster image. Web search is intentionally not
registered; external integrations belong behind Executor.

## `webfetch`

Parameters:

- `url` — required
- `format` — optional: `markdown`, `text`, `html`
- `timeout` — optional timeout in seconds, clamped to `1..120`

Current defaults:

- `defaultFormat`: `markdown`
- `timeoutSeconds`: `30`
- `maxResponseBytes`: `5 MB`
- `blockPrivateHosts`: `true`
- `maxRedirects`: `5`
- `fallbackUserAgent`: `opencode`

Behavior notes:

- only `http://` and `https://` URLs are supported
- URL userinfo credentials are rejected and redacted in diagnostics
- private, local, reserved, and multicast addresses are blocked by default
- DNS preflight failures are rejected instead of falling through to the request
- raster images (`png`, `jpeg`, `gif`, `webp`) are returned inline
- HTML is converted to Markdown or text when requested
- binary content is rejected
- Cloudflare challenge responses retry with the fallback user agent

The defaults are internal and not exposed through Pi settings. Callers can
override `format` and `timeout` per request.

## Source of truth

- extension entry: `extensions/web-tools/index.ts`
- settings/defaults: `extensions/web-tools/settings.ts`
- Pi adapter: `extensions/web-tools/webfetch.ts`
- fetch service: `extensions/web-tools/fetch-page.ts`
- public-web boundary: `extensions/web-tools/network.ts`
