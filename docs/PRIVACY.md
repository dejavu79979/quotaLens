# QuotaLens Privacy Policy

Last updated: September 11, 2026

QuotaLens is a self-hosted Even Hub app. It does not collect, sell, share, or send personal data to the QuotaLens developer. The only servers it contacts are the desktop daemon on the user's own tailnet and, from that desktop, Anthropic's and OpenAI's usage endpoints (see below).

## Network permission

QuotaLens requests only the `network` permission. The permission is used to fetch one JSON document (`UsagePayload`, defined in `shared/schema.ts` of the open-source repository) from the QuotaLens daemon running on the user's own desktop. That document contains, per tool (Claude Code and Codex): usage percentages for the five-hour and weekly windows and their reset times; the time the numbers were last fetched; an `ok` flag and a `source` label describing where the daemon obtained them; the remaining prepaid credits in USD when the provider reports them; the time the document was generated; and the display name of the Claude model the weekly limit is scoped to. It contains no account identifiers, e-mail addresses, session contents, prompts, or credentials.

The phone connects directly to that desktop over the user's private Tailscale tailnet. Usage data stays between the user's desktop, phone, and glasses.

The desktop daemon reads the OAuth tokens that the user's Claude Code and Codex CLI installations already store locally, and transmits them only as HTTPS authorization headers to Anthropic's and OpenAI's own usage endpoints in order to obtain the usage figures. The tokens are never sent to the Even Hub app, the phone, or the glasses; never written to logs, the relay response, or the repository; and never written back or refreshed by QuotaLens.

The app stores the relay address, polling preference, and last usage payload locally in the Even App so the user's settings and last-known display can survive restarts. The QuotaLens developer has no access to this local data.

## Data collection and retention

QuotaLens operates no analytics, advertising, telemetry, crash-reporting, account, or cloud storage service. Because the developer receives no user data, the developer retains no user data and has nothing to delete or disclose.

## Contact

dejavu79979@gmail.com
