export interface SessionData {
  bearerToken: string;
  username: string;
  email: string;
  customerId: number;
  services: string[];
  _accessToken: string;
  _jsessionid: string;
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

// Simple cookie jar: domain -> { name: value }
type CookieStore = Map<string, Map<string, string>>;

function domainMatch(cookieDomain: string, requestHost: string): boolean {
  if (cookieDomain === requestHost) return true;
  // .id.elisa.fi matches login.id.elisa.fi (dot-prefixed to prevent suffix attacks)
  if (requestHost.endsWith("." + cookieDomain)) return true;
  return false;
}

function parseCookies(setCookieHeaders: string[], fromUrl: string, store: CookieStore): void {
  const url = new URL(fromUrl);
  for (const header of setCookieHeaders) {
    const parts = header.split(";").map((s) => s.trim());
    const [nameVal] = parts;
    if (!nameVal) continue;
    const eqIdx = nameVal.indexOf("=");
    if (eqIdx < 0) continue;
    const name = nameVal.slice(0, eqIdx).trim();
    const value = nameVal.slice(eqIdx + 1).trim();

    // Find domain from cookie attributes
    let domain = url.hostname;
    for (const part of parts.slice(1)) {
      const lower = part.toLowerCase();
      if (lower.startsWith("domain=")) {
        domain = lower.slice(7).replace(/^\./, "");
      }
    }

    if (!store.has(domain)) store.set(domain, new Map());
    store.get(domain)!.set(name, value);
  }
}

function getCookieHeader(requestUrl: string, store: CookieStore): string {
  const url = new URL(requestUrl);
  const cookies: string[] = [];
  for (const [domain, jar] of store) {
    if (domainMatch(domain, url.hostname)) {
      for (const [name, value] of jar) {
        cookies.push(`${name}=${value}`);
      }
    }
  }
  return cookies.join("; ");
}

function getSetCookies(response: Response): string[] {
  // response.headers.getSetCookie() is available in Node 22
  return response.headers.getSetCookie?.() ?? [];
}

function resolveUrl(location: string, currentUrl: string): string {
  if (location.startsWith("http://") || location.startsWith("https://")) {
    return location;
  }
  const base = new URL(currentUrl);
  if (location.startsWith("/")) {
    return `${base.protocol}//${base.host}${location}`;
  }
  // Relative
  const pathParts = base.pathname.split("/");
  pathParts.pop();
  return `${base.protocol}//${base.host}${pathParts.join("/")}/${location}`;
}

function log(verbose: boolean, ...args: unknown[]): void {
  if (verbose) console.error("[auth]", ...args);
}

export async function authenticate(
  email: string,
  password: string,
  verbose = false,
  onTwoFactor?: () => Promise<string>
): Promise<SessionData> {
  const cookies: CookieStore = new Map();

  // === Step 1: OIDC login - follow redirects to login page ===
  log(verbose, "Step 1: Starting OIDC login flow...");

  const oidcUrl =
    "https://viihde-auth-elysium-prod.csf.elisa.fi/v1/oidc/login?theme=dark&origin=https%3A%2F%2Felisaviihde.fi%2F";

  // Follow redirects manually to capture all cookies
  let currentUrl = oidcUrl;
  for (let i = 0; i < 15; i++) {
    const cookieHeader = getCookieHeader(currentUrl, cookies);
    log(verbose, `  Redirect ${i}: ${currentUrl}`);

    const resp = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        "User-Agent": "Mozilla/5.0",
      },
    });

    const setCookies = getSetCookies(resp);
    parseCookies(setCookies, currentUrl, cookies);

    const status = resp.status;
    if (status >= 300 && status < 400) {
      const location = resp.headers.get("location");
      if (!location) throw new AuthenticationError("Redirect without Location header");
      currentUrl = resolveUrl(location, currentUrl);
      continue;
    }

    if (status === 200) {
      log(verbose, "  Landed on login page:", currentUrl);
      break;
    }

    throw new AuthenticationError(`Unexpected status ${status} at ${currentUrl}`);
  }

  // Check that step 1 redirect loop didn't exhaust all iterations
  if (!currentUrl.includes("login.id.elisa.fi")) {
    throw new AuthenticationError("Step 1 redirect loop exhausted without reaching login page");
  }

  // === Step 2: POST credentials (handles two-factor challenge) ===
  log(verbose, "Step 2: Posting credentials...");

  const loginUrl = "https://login.id.elisa.fi/api/login/password";
  const loginCookies = getCookieHeader(loginUrl, cookies);
  log(verbose, "  Cookies for login:", loginCookies ? "present" : "none");

  const loginHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Referer: "https://login.id.elisa.fi/",
    Origin: "https://login.id.elisa.fi",
    "User-Agent": "Mozilla/5.0",
    ...(loginCookies ? { Cookie: loginCookies } : {}),
  };

  type LoginResponse = {
    status: string;
    twoFactorAuthenticationId?: string;
    emergencyTwoFactorAuthentication?: boolean;
  };

  let twoFactorAuthenticationId = "";
  let twoFactorAttempts = 0;

  for (;;) {
    const payload: Record<string, unknown> = { username: email, password };
    if (twoFactorAuthenticationId) {
      const code = onTwoFactor ? await onTwoFactor() : "";
      if (!code) {
        throw new AuthenticationError(
          "Two-factor verification code required (interactive prompt not available)"
        );
      }
      payload.twoFactorAuthenticationId = twoFactorAuthenticationId;
      payload.smsChallengeCode = code;
      payload.rememberDevice = true;
      payload.language = "fi";
    }

    const loginResp = await fetch(loginUrl, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: loginHeaders,
      body: JSON.stringify(payload),
      redirect: "manual",
    });

    const loginSetCookies = getSetCookies(loginResp);
    parseCookies(loginSetCookies, loginUrl, cookies);

    if (loginResp.status !== 200) {
      throw new AuthenticationError(`Login failed with status ${loginResp.status}`);
    }

    const loginBody = (await loginResp.json()) as LoginResponse;
    log(verbose, "  Login status:", loginBody.status);

    if (loginBody.status === "OK") {
      log(verbose, "  Login OK");
      break;
    }

    if (
      loginBody.status === "TWO_FACTOR_REQUIRED" ||
      loginBody.status === "EMERGENCY_TWO_FACTOR_REQUIRED"
    ) {
      twoFactorAuthenticationId = loginBody.twoFactorAuthenticationId || "";
      if (!twoFactorAuthenticationId) {
        throw new AuthenticationError("Two-factor required but no challenge id returned");
      }
      log(
        verbose,
        "  2FA required, challenge:",
        twoFactorAuthenticationId.slice(0, 12) + "..."
      );
      continue;
    }

    if (
      loginBody.status === "TWO_FACTOR_FAILED" ||
      loginBody.status === "EMERGENCY_TWO_FACTOR_FAILED"
    ) {
      twoFactorAttempts++;
      if (twoFactorAttempts >= 5) {
        throw new AuthenticationError("Two-factor verification failed repeatedly");
      }
      log(verbose, "  2FA code rejected, asking again");
      continue;
    }

    throw new AuthenticationError(`Login failed with unexpected status: ${loginBody.status}`);
  }

  // === Step 3: Follow OIDC continue redirects to get access_token ===
  log(verbose, "Step 3: Following OIDC continue redirects...");

  let accessToken: string | null = null;
  currentUrl = "https://login.id.elisa.fi/oidc/continue";

  for (let i = 0; i < 15; i++) {
    const cookieHeader = getCookieHeader(currentUrl, cookies);
    log(verbose, `  Redirect ${i}: ${currentUrl}`);

    const resp = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "User-Agent": "Mozilla/5.0",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });

    const setCookies = getSetCookies(resp);
    parseCookies(setCookies, currentUrl, cookies);

    const status = resp.status;

    if (status >= 300 && status < 400) {
      const location = resp.headers.get("location");
      if (!location) throw new AuthenticationError("Redirect without Location header");

      // Check for errors in redirect URL
      if (location.includes("invalid_username_password")) {
        throw new AuthenticationError("Invalid username or password");
      }
      if (location.includes("error=")) {
        const errorMatch = location.match(/error=([^&]+)/);
        const descMatch = location.match(/error_description=([^&]+)/);
        throw new AuthenticationError(
          `Auth error: ${errorMatch?.[1] || "unknown"}: ${decodeURIComponent(descMatch?.[1] || "")}`
        );
      }

      // Check for access_token in fragment
      const tokenMatch = location.match(/#access_token=([^&]+)/);
      if (tokenMatch) {
        accessToken = tokenMatch[1];
        log(verbose, "  Got access_token from redirect");
        break;
      }

      currentUrl = resolveUrl(location, currentUrl);
      continue;
    }

    if (status === 200) {
      // Check if the final URL contains the token in fragment
      const body = await resp.text();
      log(verbose, `  Got 200 at ${currentUrl}, body length: ${body.length}`);
      break;
    }

    throw new AuthenticationError(`Unexpected status ${status} during OIDC continue at ${currentUrl}`);
  }

  if (!accessToken) {
    throw new AuthenticationError("Failed to extract access_token from redirect chain");
  }

  // === Step 4: Create session ===
  log(verbose, "Step 4: Creating session...");

  const sessionUrl = "https://elisaviihde.fi/api/user/create-session";
  const sessionCookies = getCookieHeader(sessionUrl, cookies);

  const sessionResp = await fetch(sessionUrl, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
      ...(sessionCookies ? { Cookie: sessionCookies } : {}),
    },
    body: `token=${encodeURIComponent(accessToken)}`,
  });

  const sessionSetCookies = getSetCookies(sessionResp);
  parseCookies(sessionSetCookies, sessionUrl, cookies);

  if (!sessionResp.ok) {
    throw new AuthenticationError(`Session creation failed with status ${sessionResp.status}`);
  }

  const sessionBody = (await sessionResp.json()) as Record<string, unknown>;
  log(verbose, "  Session created, keys:", Object.keys(sessionBody).join(", "));

  // Extract JSESSIONID from cookies
  let jsessionid = "";
  for (const [domain, jar] of cookies) {
    if (domainMatch(domain, "elisaviihde.fi")) {
      const jsid = jar.get("JSESSIONID");
      if (jsid) {
        jsessionid = jsid;
        break;
      }
    }
  }

  if (!jsessionid) {
    log(verbose, "  WARNING: No JSESSIONID cookie found");
  }

  const bearerToken = sessionBody.bearerToken as string;
  if (!bearerToken) {
    throw new AuthenticationError("No bearerToken in session response");
  }

  const sessionData: SessionData = {
    bearerToken,
    username: (sessionBody.username as string) || "",
    email: (sessionBody.email as string) || email,
    customerId: (sessionBody.customerId as number) || 0,
    services: (sessionBody.services as string[]) || [],
    _accessToken: accessToken,
    _jsessionid: jsessionid,
  };

  log(verbose, "Authentication complete!");
  return sessionData;
}
