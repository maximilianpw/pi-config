# Pi CF Paste extension

Commands:

- `/cf-paste <path>` creates a permanent private Document.
- `/cf-paste-last` uploads the latest assistant text on the active branch.
- `/cf-review <path>` and `/cf-review-last` require Plannotator approval before private upload.
- `/publish-last [1d|7d|30d|90d|never]` requires approval and atomically creates a private Document plus immutable Publication.

Set `CFPASTE_PRIVATE_ORIGIN` to the Access-protected HTTPS origin. Set `CFPASTE_PUBLIC_ORIGIN` when using `/publish-last` so returned public links can be validated. Authentication uses `cloudflared access token`; interactive TUI commands can open `cloudflared access login`, while headless modes fail with a manual-login instruction.
