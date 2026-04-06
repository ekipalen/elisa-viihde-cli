---
name: elisa-viihde
description: Use the Elisa Viihde CLI to browse TV guide, search programs, manage recordings, and record programs.
---

# Elisa Viihde

## When to use

Use this skill when the user asks about:
- What's on TV today/tomorrow
- Searching for a specific program or series
- Movies on TV or in recordings
- Recording a program
- Checking scheduled or saved recordings

## CLI commands

Always use `--json` for structured output. The CLI is at the project root.

### Browse TV guide

```bash
elisa guide --json                          # Today's programs
elisa guide tomorrow --json                 # Tomorrow's programs
elisa guide 2026-04-10 --json              # Specific date
elisa guide movies --json                   # Today's movies
elisa guide movies tomorrow --json          # Tomorrow's movies
elisa guide --channel yle --json            # Filter by channel name
```

Returns array of programs with fields: `id`, `programId`, `name`, `startTimeUTC`, `startTime`, `endTimeUTC`, `lengthMinutes`, `shortDescription`, `recordable`, `status` (`past`/`live`/`upcoming`), `channel` (object with `id`, `name`, `scrambled`), `suggestedFolderNames`.

Movies are identified by name starting with "Elokuva:" (Finnish convention).

### Search upcoming programs

```bash
elisa search "poirot" --json               # Search by name (~2 weeks ahead)
elisa search "elokuva" --json              # Search movies
elisa search "yökylässä" --rows 100 --json # More results
```

Returns array of hits with: `id`, `programId`, `title`, `source` (channel name), `startTimeFormatted`, `startTimeUTC`, `description`, `channelId`, `duration`, `recordable`. If a program is already set to record, it includes a `recording` object with `state: "scheduled"`.

### Record a program

```bash
elisa record 47936103 --json               # Record by programId
```

The programId comes from search results (`id` field) or guide results (`programId` field). Returns `{ "recordingId": ... }`. Status 409 means already recording.

### Search saved recordings

```bash
elisa recordings poirot --json             # Search by name
elisa recordings movies --json             # Recorded movies
elisa recordings "strömsö" --json          # Search name and description
```

Returns array of recordings with: `programId`, `name`, `channel`, `channelId`, `startTimeUTC`, `duration`, `description`, `recordingState`, `url` (watch link), `isWatched`, `series` (object with `seriesId`, `title`, `season`, `episode` if applicable), `thumbnail`. Searches the 5 most recent pages (250 recordings), deduplicated by episode name.

The `url` field is a direct watch link to the recording.

### Check scheduled recordings

```bash
elisa scheduled --json                     # All upcoming recordings
elisa scheduled today --json               # Today's recordings
elisa scheduled tomorrow --json            # Tomorrow's recordings
```

Returns `{ "recordings": [...], "quota": { "percentageUsed", "hoursLeft" } }`.

### Session

```bash
elisa session --json                       # Check if logged in
elisa login --save --json                  # Log in (uses stored credentials)
```

## Channel filtering

By default, premium/scrambled channels are excluded (Eurosport, Elisa Viihde Sport 1-4, Viaplay 3 Urheilu). Use `--all` to include them.

Free channels: Yle TV1, Yle TV2, MTV3, Nelonen, Yle Teema & Fem, MTV Sub, MTV Ava, Liv, Jim, TV5, Kutonen, STAR Channel, Hero, Frii, TLC, EVEO, Viaplay TV, National Geographic.

## Important notes

- The EPG has no genre field. Only movies are reliably identified (name starts with "Elokuva:"). For other genres, use `search` and interpret descriptions.
- Search covers ~2 weeks ahead. Guide covers one day at a time.
- `recordings` searches by name/description in saved recordings. It does not search upcoming programs (use `search` for that).
- `scheduled` shows programs that ARE going to be recorded. `recordings` shows programs that HAVE BEEN recorded.
- Always present results as a concise summary to the user, not raw JSON.
- When the user wants to record something, confirm the program clearly before calling `record` unless intent is unambiguous.

## Personalization

See `references/preferences.template.md` for customizing favorite genres, channels, and recording behavior.
