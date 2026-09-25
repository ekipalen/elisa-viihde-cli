#!/usr/bin/env node

import readline from "node:readline";
import { authenticate, AuthenticationError } from "./auth.js";
import {
  ElisaViihdeClient, RecordingConflictError, SCRAMBLED_CHANNEL_IDS,
  type Recording, type EpgProgram, type SearchHit,
} from "./client.js";
import { loadConfig, saveConfig, loadSession, saveSession, clearConfig, clearSession } from "./config.js";

const VERSION = "0.2.0";

function printHelp(): void {
  console.log(`elisa-viihde-cli v${VERSION}

Elisa Viihde CLI - TV guide, search and recording management.

Examples:

  elisa guide                     What's on TV today?
  elisa guide movies tomorrow     Movies on tomorrow?
  elisa search "poirot"           Is Poirot coming up soon?
  elisa record 47936103           Record a program (ID from search/guide)
  elisa recordings poirot         Any Poirot recordings saved?
  elisa recordings movies         What movies have been recorded?
  elisa scheduled today           What's being recorded today?
  elisa jalkapallo                Football matches on TV tonight & overnight

Commands:

  guide       TV guide: what's on today/tomorrow
  search      Search: find upcoming programs by name (~2 weeks)
  jalkapallo  Football: match broadcasts tonight/overnight (alias: football)
  record      Record: schedule a program for recording (needs ID)
  recordings  My recordings: search saved recordings
  scheduled   Scheduled: upcoming recordings that are set to record

  guide [today|tomorrow|YYYY-MM-DD]    Browse TV schedule
  guide movies [today|tomorrow]        Movies for the day
  search <query>                       Search upcoming programs
  record <programId>                   Record a program
  cancel <recordingId>                 Cancel a recording
  recordings <query|movies>            Search saved recordings
  scheduled [today|tomorrow]           Upcoming scheduled recordings
  jalkapallo [ilta|today|tomorrow|all] Football match broadcasts in a time window

  login [--save] [--two-factor]        Log in (--save stores credentials; --two-factor prompts for the SMS/email code)
  logout                               Log out
  session                              Show session status
  config set                           Store credentials
  config clear                         Remove stored credentials

Flags:

  --json             Machine-readable JSON output
  --two-factor       Prompt for the login verification code (SMS/email)
  --all              Include premium/scrambled channels
  --channel <name>   Filter by channel name (guide)
  --rows <n>         Number of search results, default 50
  --pages <n>        Pages to search in recordings, default 5`);
}

// --- Argument parsing ---

function parseArgs(argv: string[]): {
  command: string;
  subcommand: string;
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const args = argv.slice(2);
  let cmdIdx = 0;
  while (cmdIdx < args.length && args[cmdIdx].startsWith("-")) cmdIdx++;
  const command = args[cmdIdx] || "";
  const subcommand = args[cmdIdx + 1] && !args[cmdIdx + 1].startsWith("-") ? args[cmdIdx + 1] : "";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let startIdx = command ? cmdIdx + 1 : 0;
  if (subcommand) startIdx = cmdIdx + 2;

  // Lippujen nimet hyvaksytaan seka yhdysviivalla etta camelCasena: --two-factor
  // ja --twoFactor ovat sama asia. Ilman tata ohjeen mukainen --two-factor
  // tallentui avaimeksi "two-factor", mutta koodi tarkisti flags.twoFactor,
  // joten 2FA-kyselya ei koskaan tehty ja login paattyi virheeseen
  // "Two-factor verification code required (interactive prompt not available)".
  const setFlag = (key: string, value: string | boolean): void => {
    flags[key] = value;
    const osat = key.split("-");
    if (osat.length > 1) {
      const camel = osat[0] + osat.slice(1)
        .map((osa) => osa.charAt(0).toUpperCase() + osa.slice(1))
        .join("");
      if (!(camel in flags)) flags[camel] = value;
    }
  };

  for (let i = 0; i < cmdIdx; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-") && i + 1 < cmdIdx) { setFlag(key, next); i++; }
      else { setFlag(key, true); }
    }
  }

  for (let i = startIdx; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) { setFlag(key, next); i++; }
      else { setFlag(key, true); }
    } else {
      positional.push(arg);
    }
  }

  return { command, subcommand, positional, flags };
}

// --- Output helpers ---

function output(data: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === "string") {
    console.log(data);
  } else {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (Array.isArray(value)) console.log(`${key}: ${value.join(", ")}`);
      else if (typeof value === "object" && value !== null) console.log(`${key}: ${JSON.stringify(value)}`);
      else console.log(`${key}: ${value}`);
    }
  }
}

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      process.stdout.write(question);
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      if (stdin.isTTY) stdin.setRawMode(true);
      let input = "";
      const onData = (ch: Buffer) => {
        const c = ch.toString();
        if (c === "\n" || c === "\r") {
          stdin.removeListener("data", onData);
          if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
          rl.close(); process.stdout.write("\n"); resolve(input);
        } else if (c === "\u007f" || c === "\b") { input = input.slice(0, -1); }
        else if (c === "\u0003") { process.exit(1); }
        else { input += c; }
      };
      stdin.on("data", onData);
    } else {
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
    }
  });
}

// --- Auth helpers ---

async function resolveCredentials(flags: Record<string, string | boolean>): Promise<{ email: string; password: string }> {
  let email = typeof flags.email === "string" ? flags.email : "";
  let password = typeof flags.password === "string" ? flags.password : "";
  if (email && password) return { email, password };

  if (!email) email = process.env.ELISA_EMAIL || "";
  if (!password) password = process.env.ELISA_PASSWORD || "";
  if (email && password) return { email, password };

  const config = loadConfig();
  if (config) {
    if (!email) email = config.email;
    if (!password) password = config.password;
  }
  if (email && password) return { email, password };

  if (!process.stdin.isTTY) throw new Error("Missing credentials. Use --email/--password, env vars, or 'elisa config set'");
  if (!email) email = await ask("Email: ");
  if (!password) password = await ask("Password: ", true);
  return { email, password };
}

function requireSession(): ElisaViihdeClient {
  const session = loadSession();
  if (!session) { console.error("No active session. Run 'elisa login' first."); process.exit(1); }
  return new ElisaViihdeClient(session);
}

// --- Date/time helpers ---

function helsinkiDay(offsetDays: number): { start: Date; end: Date } {
  // Get today's date string in Helsinki
  const target = new Date(Date.now() + offsetDays * 86400000);
  const dateStr = target.toLocaleDateString("sv-SE", { timeZone: "Europe/Helsinki" });
  // Try both +02:00 (winter) and +03:00 (summer), see which one gives the right local date
  for (const offset of [2, 3]) {
    const attempt = new Date(`${dateStr}T00:00:00+0${offset}:00`);
    const check = attempt.toLocaleDateString("sv-SE", { timeZone: "Europe/Helsinki" });
    if (check === dateStr) {
      return { start: attempt, end: new Date(attempt.getTime() + 86400000) };
    }
  }
  // Fallback to +02:00
  const start = new Date(`${dateStr}T00:00:00+02:00`);
  return { start, end: new Date(start.getTime() + 86400000) };
}

/** Epoch seconds for a given clock time (hour:00) on the Helsinki day `offsetDays` from today. */
function helsinkiClockSec(offsetDays: number, hour: number): number {
  const dateStr = new Date(Date.now() + offsetDays * 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Helsinki" });
  const hh = String(hour).padStart(2, "0");
  for (const off of [2, 3]) {
    const attempt = new Date(`${dateStr}T${hh}:00:00+0${off}:00`);
    if (attempt.toLocaleDateString("sv-SE", { timeZone: "Europe/Helsinki" }) === dateStr) {
      return Math.floor(attempt.getTime() / 1000);
    }
  }
  return Math.floor(new Date(`${dateStr}T${hh}:00:00+03:00`).getTime() / 1000);
}

/** Resolve "today", "tomorrow", or YYYY-MM-DD to a date string. */
function resolveDate(input: string): string {
  if (input === "today" || !input) {
    return helsinkiDateStr(0);
  }
  if (input === "tomorrow") {
    return helsinkiDateStr(1);
  }
  return input; // assume YYYY-MM-DD
}

/** Get YYYY-MM-DD string in Helsinki timezone. */
function helsinkiDateStr(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  // Use sv-SE locale which gives YYYY-MM-DD format
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Helsinki" });
}

function filterRecordingsByDay(recordings: Recording[], offsetDays: number): Recording[] {
  const { start, end } = helsinkiDay(offsetDays);
  return recordings.filter((r) => {
    const t = r.startTimeUTC ?? 0;
    return t >= start.getTime() && t < end.getTime();
  });
}

// --- Formatting helpers ---

function recordingUrl(r: Recording): string {
  return `https://elisaviihde.fi/tallenne/katso/${r.programId}`;
}

function formatRecording(r: Recording): string {
  let time = "";
  if (r.startTimeUTC) time = new Date(r.startTimeUTC).toLocaleString("fi-FI", { timeZone: "Europe/Helsinki" });
  else if (r.startTime) time = r.startTime;
  const episode = r.seasonNumber && r.episodeNumber ? ` S${r.seasonNumber}E${r.episodeNumber}` : "";
  const series = r.seriesName && r.seriesName !== r.name ? ` (${r.seriesName})` : "";
  return `[${r.programId}] ${r.name}${series}${episode} | ${r.channel || ""} | ${time}\n  ${recordingUrl(r)}`;
}

function formatEpgProgram(p: EpgProgram): string {
  const time = new Date(p.startTimeUTC).toLocaleTimeString("fi-FI", {
    timeZone: "Europe/Helsinki", hour: "2-digit", minute: "2-digit",
  });
  const dur = p.lengthMinutes ? ` (${p.lengthMinutes}min)` : "";
  return `[${p.programId}] ${time} ${p.name}${dur} | ${p.channel?.name || ""}`;
}

function isScrambled(channelId: number): boolean {
  return SCRAMBLED_CHANNEL_IDS.has(channelId);
}

function isMovie(p: EpgProgram): boolean {
  return p.name.startsWith("Elokuva:") ||
    p.suggestedFolderNames?.includes("Elokuvat") === true;
}

// --- Main ---

async function main(): Promise<void> {
  const { command, subcommand, positional, flags } = parseArgs(process.argv);
  const json = flags.json === true;
  const verbose = flags.verbose === true;
  const includeAll = flags.all === true;

  try {
    if (flags.version === true) { console.log(VERSION); return; }
    if (flags.help === true || command === "") { printHelp(); return; }

    switch (command) {
      case "login": {
        const { email, password } = await resolveCredentials(flags);
        const onTwoFactor = flags.twoFactor === true
          ? async (): Promise<string> => {
              const code = await ask("Tunnistautumiskoodi (sähköposti/SMS): ");
              return code.trim();
            }
          : undefined;
        const session = await authenticate(email, password, verbose, onTwoFactor);
        saveSession(session);
        if (flags.save === true) {
          saveConfig(email, password);
        }
        if (json) {
          output({ status: "ok", username: session.username, email: session.email, services: session.services }, true);
        } else {
          console.log(`Logged in as ${session.username || session.email} (services: ${session.services.join(", ")})`);
          if (flags.save === true) {
            console.log("Credentials saved to ~/.config/elisa-viihde/config.json");
          }
        }
        break;
      }

      case "session": {
        const session = loadSession();
        if (!session) { output(json ? { error: "No active session" } : "No active session. Run 'elisa login' first.", json); process.exitCode = 1; return; }
        output(new ElisaViihdeClient(session).userInfo, json);
        break;
      }

      case "search": {
        const query = subcommand || positional[0];
        if (!query) { output(json ? { error: "Missing search query" } : "Usage: elisa search <query>", json); process.exitCode = 1; return; }
        const client = requireSession();
        const rows = typeof flags.rows === "string" ? parseInt(flags.rows, 10) : 50;
        let results = await client.search(query, rows);

        // Filter out scrambled channels by default
        if (!includeAll) {
          results = results.filter((h) => !h.channelId || !isScrambled(h.channelId));
        }

        if (json) {
          output(results, true);
        } else if (results.length === 0) {
          console.log("No results found.");
        } else {
          for (const hit of results) {
            const rec = (hit as Record<string, unknown>).recording ? " [REC]" : "";
            console.log(
              `[${hit.id}] ${hit.title}${hit.source ? ` | ${hit.source}` : ""}${hit.startTimeFormatted ? ` | ${hit.startTimeFormatted}` : ""}${rec}`
            );
            if (hit.description) console.log(`  ${hit.description.slice(0, 120)}`);
          }
          console.log(`\n${results.length} result(s)`);
        }
        break;
      }

      case "football":
      case "jalkapallo": {
        const client = requireSession();

        // The search API hard-caps at 5 hits per query, so we run several
        // football-related queries and merge the unique results. Match
        // broadcasts ("Team - Team") often lack the word "jalkapallo", so
        // tournament/league keywords are needed to catch them.
        const KEYWORDS = [
          "jalkapallo", "FIFA", "World Cup",
          "Valioliiga", "Mestarien liiga", "Veikkausliiga", "Champions League",
        ];
        const byId = new Map<number, SearchHit>();
        await Promise.all(KEYWORDS.map(async (kw) => {
          try {
            for (const h of await client.search(kw, 5)) {
              const id = h.id ?? (h.programId as number | undefined);
              if (typeof id === "number" && !byId.has(id)) byId.set(id, h);
            }
          } catch { /* ignore a failing keyword, keep the rest */ }
        }));

        // Drop hits that match a football keyword but are not football, e.g.
        // equestrian "Global Champions League" on HorseTV.
        const NOT_FOOTBALL = /global champions league|ratsastus|hevos|formula|nascar|esports|football manager/i;

        // Classify: a real match has a "Team - Team" / "Team vs Team" title and
        // is not a studio/highlights/magazine/preview programme.
        const STUDIO = /studio|huippuhetk|kooste|tarinoita|makasiini|magazine|highlights|review|goals of|stories|enn?akko|lähetys ennen|tältä tuntuu/i;
        const VERSUS = / [-–] | vs\.? /i;
        const category = (t: string): "ottelu" | "studio" | "muu" =>
          STUDIO.test(t) ? "studio" : VERSUS.test(t) ? "ottelu" : "muu";

        // Time window. A football "day" runs from 00:00 until 06:00 the NEXT
        // morning, so matches that kick off in the small hours (e.g. 03:35,
        // tournament in the US → late night Finnish time) count as part of that
        // evening's football — they appear under "today" even though their
        // calendar date is tomorrow.
        const OVERNIGHT_END = 6; // 06:00 = end of the small hours
        const nowSec = Math.floor(Date.now() / 1000);
        const win = subcommand || "today";
        let lo: number, hi: number;
        if (win === "all" || win === "week" || win === "kaikki") {
          lo = nowSec - 3 * 3600; hi = nowSec + 14 * 86400;
        } else if (win === "tomorrow" || win === "huomenna") {
          lo = helsinkiClockSec(1, 0); hi = helsinkiClockSec(2, OVERNIGHT_END);
        } else {
          // default / "today" / "tänään" / "ilta": today + overnight into tomorrow morning
          lo = helsinkiClockSec(0, 0); hi = helsinkiClockSec(1, OVERNIGHT_END);
        }

        const showStudios = flags.studiot === true || flags["all-types"] === true;
        const matches = [...byId.values()]
          .filter((h) => !NOT_FOOTBALL.test((h.title ?? (h.name as string | undefined) ?? "")))
          .map((h) => {
            const title = (h.title ?? (h.name as string | undefined) ?? "").trim();
            const st = h.startTimeUTC ?? 0;
            const durSec = h.duration ?? 0;
            return {
              programId: (h.programId as number | undefined) ?? h.id,
              title,
              channel: h.source ?? (h.channel as string | undefined) ?? "",
              startTimeUTC: st,
              startTime: h.startTimeFormatted ?? "",
              durationMinutes: durSec ? Math.round(durSec / 60) : undefined,
              category: category(title),
              status: nowSec < st ? "upcoming" : nowSec < st + durSec ? "live" : "past",
              description: h.description,
            };
          })
          .filter((m) => m.startTimeUTC >= lo && m.startTimeUTC < hi)
          .filter((m) => showStudios || m.category === "ottelu")
          .sort((a, b) => a.startTimeUTC - b.startTimeUTC);

        if (json) {
          output(matches, true);
        } else if (matches.length === 0) {
          console.log("Ei jalkapallo-otteluita annetulla aikavälillä.");
        } else {
          for (const m of matches) {
            const live = m.status === "live" ? " 🔴 NYT" : "";
            const kind = m.category === "studio" ? " (studio)" : "";
            console.log(`[${m.programId}] ${m.startTime} | ${m.channel} | ${m.title}${kind}${live}`);
          }
          console.log(`\n${matches.length} lähetys(tä)`);
        }
        break;
      }

      case "guide": {
        const client = requireSession();
        const moviesMode = subcommand === "movies";
        const dateArg = moviesMode ? (positional[0] || "today") : (subcommand || "today");
        const date = resolveDate(dateArg);

        const schedule = await client.getSchedule(date);
        let programs: EpgProgram[] = [];

        for (const block of schedule.schedule) {
          for (const p of block.programs) {
            if (p.status === "past") continue;
            if (!includeAll && p.channel?.scrambled) continue;
            if (!p.recordable && !includeAll) continue;
            programs.push(p);
          }
        }

        if (moviesMode) {
          programs = programs.filter(isMovie);
        }

        if (typeof flags.channel === "string") {
          const ch = flags.channel.toLowerCase();
          programs = programs.filter((p) => p.channel?.name?.toLowerCase().includes(ch));
        }

        programs.sort((a, b) => a.startTimeUTC - b.startTimeUTC);

        if (json) {
          output(programs, true);
        } else {
          const label = moviesMode ? `Movies on ${date}` : `Guide for ${date}`;
          console.log(`${label}: ${programs.length} programs\n`);
          for (const p of programs) {
            console.log(formatEpgProgram(p));
            if (p.shortDescription) console.log(`  ${p.shortDescription.slice(0, 120)}`);
          }
        }
        break;
      }

      case "record": {
        const programIdStr = subcommand || positional[0];
        if (!programIdStr) { output(json ? { error: "Missing programId" } : "Usage: elisa record <programId>", json); process.exitCode = 1; return; }
        const id = parseInt(programIdStr, 10);
        if (isNaN(id)) { output(json ? { error: "Invalid programId: must be a number" } : "Error: programId must be a number.", json); process.exitCode = 1; return; }
        const client = requireSession();
        const result = await client.record(id);
        output(json ? result : `Recording scheduled (recordingId: ${result.recordingId})`, json);
        break;
      }

      case "cancel": {
        const recordingIdStr = subcommand || positional[0];
        if (!recordingIdStr) { output(json ? { error: "Missing recordingId" } : "Usage: elisa cancel <recordingId>", json); process.exitCode = 1; return; }
        const id = parseInt(recordingIdStr, 10);
        if (isNaN(id)) { output(json ? { error: "Invalid recordingId: must be a number" } : "Error: recordingId must be a number.", json); process.exitCode = 1; return; }
        const client = requireSession();
        await client.cancelRecording(id);
        output(json ? { status: "ok" } : "Recording cancelled.", json);
        break;
      }

      case "scheduled": {
        const client = requireSession();
        const data = await client.listScheduled();
        let recordings = data.recordings || [];

        // Deduplicate by programId
        const seenIds = new Set<number>();
        recordings = recordings.filter((r) => {
          if (seenIds.has(r.programId)) return false;
          seenIds.add(r.programId);
          return true;
        });

        if (subcommand === "today") recordings = filterRecordingsByDay(recordings, 0);
        else if (subcommand === "tomorrow") recordings = filterRecordingsByDay(recordings, 1);

        if (json) {
          output({ recordings, quota: data.quota }, true);
        } else {
          const label = subcommand === "today" ? " (today)" : subcommand === "tomorrow" ? " (tomorrow)" : "";
          console.log(`Scheduled recordings${label}: ${recordings.length}`);
          if (!subcommand && data.quota) {
            console.log(`Quota: ${data.quota.percentageUsed}% used, ${data.quota.hoursLeft}h left\n`);
          } else { console.log(); }
          for (const r of recordings) console.log(formatRecording(r));
        }
        break;
      }

      case "recordings": {
        const query = subcommand || positional[0] || "";
        if (!query) {
          output(json ? { error: "Missing search query" } : "Usage: elisa recordings <query>  or  elisa recordings movies", json);
          process.exitCode = 1;
          return;
        }
        const client = requireSession();
        const maxPages = typeof flags.pages === "string" ? parseInt(flags.pages, 10) : 5;
        const recordings = await client.searchRecordings(query, maxPages);

        if (json) {
          output(recordings.map((r) => ({ ...r, url: recordingUrl(r) })), true);
        } else {
          console.log(`Recordings matching "${query}": ${recordings.length}\n`);
          for (const r of recordings) console.log(formatRecording(r));
        }
        break;
      }

      case "logout": {
        clearSession();
        output(json ? { status: "ok" } : "Session cleared.", json);
        break;
      }

      case "config": {
        if (subcommand === "set") {
          const email = await ask("Email: ");
          const password = await ask("Password: ", true);
          saveConfig(email, password);
          output(json ? { status: "ok" } : "Config saved.", json);
        } else if (subcommand === "clear") {
          clearConfig();
          output(json ? { status: "ok" } : "Config cleared.", json);
        } else {
          output(json ? { error: "Unknown config subcommand" } : "Usage: elisa config <set|clear>", json);
          process.exitCode = 1;
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof AuthenticationError) {
      output(json ? { error: err.message } : `Authentication error: ${err.message}`, json);
      process.exitCode = 1;
    } else if (err instanceof RecordingConflictError) {
      output(json ? { error: err.message } : `Conflict: ${err.message}`, json);
      process.exitCode = 1;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      output(json ? { error: message } : `Error: ${message}`, json);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
