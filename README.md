# elisa-viihde-cli

Unofficial CLI tool for Elisa Viihde — TV guide, search and recording management. Built for humans and AI agents.

> **Disclaimer:** This project is not affiliated with, endorsed by, or connected to Elisa Corporation. "Elisa" and "Elisa Viihde" are trademarks of Elisa Corporation. This is an independent, open-source tool that interacts with publicly available APIs.

## Use with OpenClaw

This CLI is designed to work with [OpenClaw](https://openclaw.ai) bots. The repo includes a ready-made skill definition.

### 1. Install the CLI

```bash
git clone https://github.com/ekipalen/elisa-viihde-cli.git
cd elisa-viihde-cli
npm install
npm run build
npm link              # makes 'elisa' command available globally
```

Requires Node.js 22+. No external dependencies.

### 2. Log in

```bash
elisa login --save
```

This authenticates with Elisa Viihde and stores credentials for automatic re-login when the session expires. Alternatively, set `ELISA_EMAIL` and `ELISA_PASSWORD` environment variables.

### 3. Install the skill

Copy the included skill to your OpenClaw bot, or point to it:

```bash
cp -r skills/elisa-viihde /path/to/your/openclaw/skills/
```

The skill definition is in `skills/elisa-viihde/SKILL.md`. It teaches the bot how to use the CLI with `--json` output.

### 4. Customize (optional)

Copy and edit the preferences template to personalize the bot's behavior:

```bash
cp skills/elisa-viihde/references/preferences.template.md \
   skills/elisa-viihde/references/preferences.md
```

Add your favorite genres, channels, and recording preferences.

## Quick start

```bash
elisa guide                     # What's on TV today?
elisa guide movies tomorrow     # Movies on tomorrow?
elisa search "poirot"           # Is Poirot coming up soon?
elisa record 47936103           # Record a program (ID from search/guide)
elisa recordings poirot         # Any Poirot recordings saved?
elisa recordings movies         # What movies have been recorded?
elisa scheduled today           # What's being recorded today?
```

## Commands

| Command | Description |
|---------|-------------|
| `guide [today\|tomorrow\|date]` | TV guide: what's on |
| `guide movies [day]` | Movies for the day |
| `search <query>` | Search upcoming programs (~2 weeks) |
| `record <programId>` | Record a program |
| `cancel <recordingId>` | Cancel a recording |
| `recordings <query\|movies>` | Search saved recordings |
| `scheduled [today\|tomorrow]` | Upcoming scheduled recordings |

All commands support `--json` for machine-readable output. Use `--all` to include premium channels.

## Authentication

Credentials are resolved in order:
1. `--email` / `--password` flags
2. `ELISA_EMAIL` / `ELISA_PASSWORD` environment variables
3. Stored config (`elisa config set` or `elisa login --save`)
4. Interactive prompts

Credentials are stored with base64 obfuscation (not encryption) at `~/.config/elisa-viihde/config.json` with `0600` permissions. Session data is stored at `~/.config/elisa-viihde/session.json`.

## License

MIT
