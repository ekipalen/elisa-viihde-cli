# Changelog

## Unreleased

- Two-factor authentication (2FA) support: `elisa login --save --two-factor`
  prompts for the SMS/email verification code. Handles `TWO_FACTOR_REQUIRED` /
  `EMERGENCY_TWO_FACTOR_REQUIRED` challenges, retries on failed codes, and
  sends the "remember device" flag.

## 0.2.0 (2026-04-06)

- TV guide: `guide`, `guide movies`, date and channel filtering
- Search upcoming programs with `search`
- Recording search with `recordings <query|movies>` (deduplicated)
- Scheduled recordings with `scheduled [today|tomorrow]`
- Record and cancel programs
- Auto-relogin on session expiry (when credentials stored)
- Watch URLs in recording output
- Premium channel filtering (default: excluded, `--all` to include)
- `--json` flag on all commands for agent/bot use
- OpenClaw skill definition (`skills/elisa-viihde`)

## 0.1.0 (2026-04-06)

- Initial release
- OIDC authentication (pure HTTP, no browser)
- Session and credential management
