# Cursor Grok provider

Minimal Pi provider for Cursor's `grok-4.6` model. It depends directly on `@cursor/sdk`; it does not install or vendor `pi-cursor-sdk`.

Published models:

- `cursor/grok-4.6`
- `cursor/grok-4.6:fast`
- `cursor/grok-4.6:slow`

The extension sends the current Pi transcript to a fresh local Cursor agent for each turn, streams text and thinking back to Pi, forwards images, reports token usage, supports cancellation, and deletes its temporary Cursor state afterward.

Cursor runs its native tools automatically in the current working directory with SDK auto-review enabled but without an SDK sandbox. Those operations do not pass through Pi's tool confirmations or `safety-guard`, and they are not replayed in Pi's transcript. This intentionally does not implement cloud agents, session resume, Cursor replay cards, model discovery, or a bridge to Pi tools.

Authenticate with `/login` and choose Cursor, or set `CURSOR_API_KEY`.
