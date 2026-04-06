import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionData } from "./auth.js";

const CONFIG_DIR_NAME = "elisa-viihde";

function getConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, CONFIG_DIR_NAME);
}

function ensureConfigDir(): string {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);  // Fix perms even if dir existed
  return dir;
}

function configPath(): string {
  return path.join(getConfigDir(), "config.json");
}

function sessionPath(): string {
  return path.join(getConfigDir(), "session.json");
}

const SALT = "elisa-viihde::";

function obfuscate(password: string): string {
  return Buffer.from(SALT + password).toString("base64");
}

function deobfuscate(encoded: string): string {
  const decoded = Buffer.from(encoded, "base64").toString("utf-8");
  if (!decoded.startsWith(SALT)) {
    throw new Error("Invalid obfuscated password");
  }
  return decoded.slice(SALT.length);
}

export interface Config {
  email: string;
  passwordObfuscated: string;
}

export function loadConfig(): { email: string; password: string } | null {
  // Env vars take priority
  const envEmail = process.env.ELISA_EMAIL;
  const envPassword = process.env.ELISA_PASSWORD;
  if (envEmail && envPassword) {
    return { email: envEmail, password: envPassword };
  }

  const p = configPath();
  if (!fs.existsSync(p)) return null;

  try {
    const data: Config = JSON.parse(fs.readFileSync(p, "utf-8"));
    return {
      email: data.email,
      password: deobfuscate(data.passwordObfuscated),
    };
  } catch {
    return null;
  }
}

export function saveConfig(email: string, password: string): void {
  const dir = ensureConfigDir();
  const data: Config = {
    email,
    passwordObfuscated: obfuscate(password),
  };
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function loadSession(): SessionData | null {
  const p = sessionPath();
  if (!fs.existsSync(p)) return null;

  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as SessionData;
  } catch {
    return null;
  }
}

export function saveSession(data: SessionData): void {
  const dir = ensureConfigDir();
  const p = path.join(dir, "session.json");
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function clearConfig(): void {
  const dir = getConfigDir();
  for (const file of ["config.json", "session.json"]) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

export function clearSession(): void {
  const p = sessionPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
