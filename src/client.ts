import { authenticate, type SessionData } from "./auth.js";
import { loadConfig, saveSession } from "./config.js";

export class RecordingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordingConflictError";
  }
}

export class SessionExpiredError extends Error {
  constructor() {
    super("Session expired");
    this.name = "SessionExpiredError";
  }
}

export interface SearchHit {
  id: number;
  title: string;
  source?: string;
  channelId?: number;
  startTimeUTC?: number;
  startTimeFormatted?: string;
  duration?: number;
  description?: string;
  [key: string]: unknown;
}

export class ElisaViihdeClient {
  private session: SessionData;
  private autoRelogin: boolean;

  constructor(session: SessionData, autoRelogin = true) {
    this.session = session;
    this.autoRelogin = autoRelogin;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: this.session.bearerToken,
      "User-Agent": "Mozilla/5.0",
      Referer: "https://elisaviihde.fi/",
      Origin: "https://elisaviihde.fi",
    };
    if (this.session._jsessionid) {
      h["Cookie"] = `JSESSIONID=${this.session._jsessionid}`;
    }
    return h;
  }

  /** Make a fetch request with auto-relogin on 401/403. */
  private async request(url: string, init?: RequestInit): Promise<Response> {
    const resp = await fetch(url, {
      ...init,
      headers: { ...this.headers, ...init?.headers },
    });

    if ((resp.status === 401 || resp.status === 403) && this.autoRelogin) {
      const refreshed = await this.tryRelogin();
      if (refreshed) {
        return fetch(url, {
          ...init,
          headers: { ...this.headers, ...init?.headers },
        });
      }
    }

    return resp;
  }

  /** Try to re-authenticate using stored config or env vars. */
  private async tryRelogin(): Promise<boolean> {
    const config = loadConfig();
    if (!config) return false;

    try {
      const newSession = await authenticate(config.email, config.password);
      this.session = newSession;
      saveSession(newSession);
      return true;
    } catch {
      return false;
    }
  }

  async search(query: string, rows = 25): Promise<SearchHit[]> {
    const url = `https://elisaviihde.fi/haku/api/query?q=${encodeURIComponent(query)}&start=0&rows=${rows}`;
    const resp = await this.request(url);

    if (!resp.ok) {
      throw new Error(`Search failed: ${resp.status} ${resp.statusText}`);
    }

    const data = (await resp.json()) as {
      results?: { epg?: { searchHits?: SearchHit[] } };
    };

    return data?.results?.epg?.searchHits ?? [];
  }

  async record(programId: number): Promise<{ recordingId: number }> {
    const url = "https://elisaviihde.fi/tallenteet/api/recordings";
    const resp = await this.request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ programId, folderId: 0 }),
    });

    if (resp.status === 409) {
      throw new RecordingConflictError("Recording already exists for this program");
    }

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Record failed: ${resp.status} ${body}`);
    }

    return (await resp.json()) as { recordingId: number };
  }

  async cancelRecording(recordingId: number): Promise<void> {
    const url = `https://elisaviihde.fi/tallenteet/api/recordings/${recordingId}`;
    const resp = await this.request(url, { method: "DELETE" });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Cancel recording failed: ${resp.status} ${body}`);
    }
  }

  /** List scheduled (upcoming) recordings. */
  async listScheduled(): Promise<ScheduledRecordingsResult> {
    const url = "https://elisaviihde.fi/tallenteet/api/recordings/scheduled";
    const resp = await this.request(url);

    if (!resp.ok) {
      throw new Error(`List scheduled failed: ${resp.status}`);
    }

    return (await resp.json()) as ScheduledRecordingsResult;
  }

  /** List completed/finished recordings in a folder (paginated, 50/page). */
  async listRecordings(folderId = 0, page = 0): Promise<Recording[]> {
    const url = `https://elisaviihde.fi/tallenteet/api/recordings/${folderId}?page=${page}`;
    const resp = await this.request(url);

    if (!resp.ok) {
      throw new Error(`List recordings failed: ${resp.status}`);
    }

    return (await resp.json()) as Recording[];
  }

  /** Search recordings by fetching recent pages and filtering by name.
   *  Returns deduplicated results (one per episode name), newest first.
   */
  async searchRecordings(query: string, maxPages = 5): Promise<Recording[]> {
    const q = query.toLowerCase();
    const isMovies = q === "elokuva" || q === "elokuvat" || q === "movies";
    const results: Recording[] = [];
    const seen = new Set<string>();

    for (let page = 0; page < maxPages; page++) {
      const recs = await this.listRecordings(0, page);
      if (recs.length === 0) break;

      for (const r of recs) {
        const name = r.name || "";
        // Deduplicate by name
        if (seen.has(name)) continue;
        seen.add(name);

        if (isMovies) {
          if (name.startsWith("Elokuva:")) results.push(r);
        } else {
          if (name.toLowerCase().includes(q) ||
              (r.description || "").toLowerCase().includes(q)) {
            results.push(r);
          }
        }
      }
    }

    return results;
  }

  /** List recording folders. */
  async listFolders(): Promise<Folder[]> {
    const url = "https://elisaviihde.fi/tallenteet/api/folders";
    const resp = await this.request(url);

    if (!resp.ok) {
      throw new Error(`List folders failed: ${resp.status}`);
    }

    return (await resp.json()) as Folder[];
  }

  /** Get EPG schedule for a date. Returns all channels' programs. */
  async getSchedule(date?: string): Promise<EpgSchedule> {
    let url = "https://viihde-epg-api-prod.csf.elisa.fi/epg/schedule";
    if (date) url += `?date=${date}`;
    const resp = await this.request(url);

    if (!resp.ok) {
      throw new Error(`Schedule failed: ${resp.status}`);
    }

    return (await resp.json()) as EpgSchedule;
  }

  /** Get channel list. */
  async getChannels(): Promise<Channel[]> {
    const url = "https://viihde-epg-api-prod.csf.elisa.fi/epg/channels";
    const resp = await this.request(url);

    if (!resp.ok) {
      throw new Error(`Channels failed: ${resp.status}`);
    }

    return (await resp.json()) as Channel[];
  }

  get userInfo(): Record<string, unknown> {
    const info: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.session)) {
      if (!key.startsWith("_")) {
        info[key] = value;
      }
    }
    return info;
  }
}

export interface Recording {
  programId: number;
  recordingId?: number;
  name: string;
  channel: string;
  startTime?: string;
  startTimeUTC?: number;
  endTimeUTC?: number;
  duration: number;
  recordingState: string;
  description?: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  [key: string]: unknown;
}

export interface ScheduledRecordingsResult {
  recordings: Recording[];
  folder: { id: number; name: string; recordings: number; [key: string]: unknown };
  quota: { percentageUsed: number; hoursLeft: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface Folder {
  id: number;
  name: string;
  recordings: number;
  [key: string]: unknown;
}

export interface EpgProgram {
  id: number;
  programId: number;
  name: string;
  startTime: string;
  endTime: string;
  startTimeUTC: number;
  endTimeUTC: number;
  lengthMinutes: number;
  shortDescription?: string;
  recordable: boolean;
  status: "past" | "live" | "upcoming";
  suggestedFolderNames?: string[];
  channel: { id: number; name: string; scrambled: boolean; recordable: boolean };
  [key: string]: unknown;
}

export interface EpgScheduleBlock {
  programs: EpgProgram[];
  [key: string]: unknown;
}

export interface EpgSchedule {
  timezone: string;
  schedule: EpgScheduleBlock[];
}

export interface Channel {
  id: number;
  name: string;
  scrambled: boolean;
  recordable: boolean;
  [key: string]: unknown;
}

/** IDs of scrambled/premium channels that are excluded by default. */
export const SCRAMBLED_CHANNEL_IDS = new Set([
  26,   // Eurosport
  227,  // Viaplay 3 Urheilu
  259,  // Elisa Viihde Sport 1
  260,  // Elisa Viihde Sport 2
  263,  // Elisa Viihde Sport 3
  264,  // Elisa Viihde Sport 4
]);
