import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";

// ─── Types ───────────────────────────────────────────────────────
interface QuotaEntry {
  level: string;
  percent: number;
  resetTimestamp: number;
}

interface UsageData {
  quotas: QuotaEntry[];
  _ts: number;
}

// ─── Session Storage ─────────────────────────────────────────────
function getSessionPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return join(home, ".pi", "agent", "volcengine-session.json");
}

function hasSession(): boolean {
  return existsSync(getSessionPath());
}

// ─── Helpers ─────────────────────────────────────────────────────
function humanDuration(untilMs: number): string {
  if (untilMs <= 0) return "now";
  const m = Math.floor(untilMs / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m % 60}m`;
}

const LEVEL_LABELS: Record<string, string> = {
  session: "5h",
  weekly: "Wk",
  monthly: "Mo",
};

const LEVEL_WINDOWS: Record<string, number> = {
  session: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/** Returns severity: 0=normal, 1=above expected, 2=critical */
function usageSeverity(pct: number, level: string, resetTimestamp: number): number {
  if (resetTimestamp <= 0) return 0; // no active window
  const windowMs = LEVEL_WINDOWS[level] || 5 * 60 * 60 * 1000;
  const remainingMs = resetTimestamp * 1000 - Date.now();
  const elapsedMs = Math.max(0, windowMs - remainingMs);
  const elapsedRatio = elapsedMs / windowMs;
  const expectedPct = elapsedRatio * 100;

  if (pct > expectedPct * 1.5) return 2;
  if (pct > expectedPct) return 1;
  return 0;
}

// ─── Fetch Usage ─────────────────────────────────────────────────
async function fetchUsage(): Promise<UsageData> {
  const sessionPath = getSessionPath();
  if (!existsSync(sessionPath)) {
    throw new Error("No session. Run /volcengine-usage-login first.");
  }

  const state = JSON.parse(readFileSync(sessionPath, "utf-8"));
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

  try {
    const context = await browser.newContext({ storageState: state });
    const page = await context.newPage();

    await page.goto("https://console.volcengine.com", {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });

    const result = await page.evaluate(async () => {
      const csrfToken = document.cookie
        .split("; ")
        .find((r) => r.startsWith("csrfToken="))
        ?.split("=")[1];
      const resp = await fetch(
        "https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetCodingPlanUsage?",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: "{}",
          credentials: "include",
        }
      );
      return await resp.json();
    });

    if (result.ResponseMetadata?.Error) {
      const code = result.ResponseMetadata.Error.Code;
      if (code === "NotLogin" || code === "NotLogged") {
        // Session expired — delete it
        if (existsSync(sessionPath)) unlinkSync(sessionPath);
        throw new Error("Session expired. Run /volcengine-usage-login to re-login.");
      }
      throw new Error(result.ResponseMetadata.Error.Message || "API Error");
    }

    return {
      quotas: (result.Result?.QuotaUsage || []).map((q: any) => ({
        level: q.Level,
        percent: Math.round(q.Percent * 10) / 10,
        resetTimestamp: q.ResetTimestamp,
      })),
      _ts: Date.now(),
    };
  } finally {
    await browser.close();
  }
}

// ─── Main ────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  let usage: UsageData | null = null;
  const CACHE_MS = 60_000;
  let thinkingLevel = "off";

  // ── Events (no auto-fetch — only /volcengine-usage command launches browser) ──
  pi.on("session_start", async (_e, _ctx) => {
    thinkingLevel = pi.getThinkingLevel?.() || "off";
  });

  pi.on("thinking_level_select", async (event: any) => {
    thinkingLevel = event.level || "off";
  });

  // ── /volcengine-usage ──────────────────────────────────────────
  pi.registerCommand("volcengine-usage", {
    description: "Show Volcengine Coding Plan usage",
    handler: async (_args, ctx) => {
      try {
        usage = await fetchUsage();
        const lines = ["══ Volcengine Coding Plan Usage ══"];
        for (const q of usage.quotas) {
          const label = LEVEL_LABELS[q.level] || q.level;
          const pct = Math.round(q.percent * 10) / 10;
          const bar =
            "█".repeat(Math.min(20, Math.round(pct / 5))) +
            "░".repeat(Math.max(0, 20 - Math.round(pct / 5)));
          // ResetTimestamp: -1 means no active window
          let resetStr = "-";
          if (q.resetTimestamp > 0) {
            const sev = usageSeverity(pct, q.level, q.resetTimestamp);
            const flag = sev === 2 ? "!!" : sev === 1 ? "!" : "";
            resetStr = `resets ${humanDuration(q.resetTimestamp * 1000 - Date.now())}`;
            lines.push(`${flag}${label}  ${bar}  ${pct}%  ${resetStr}`);
          } else {
            lines.push(`${label}  ${bar}  ${pct}%  (no active window)`);
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err: any) {
        ctx.ui.notify(`Volcengine Usage: ${err.message}`, "error");
      }
    },
  });

  // ── /volcengine-usage-login ────────────────────────────────────
  pi.registerCommand("volcengine-usage-login", {
    description: "Open browser to log in to Volcengine console",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Opening browser for login...", "info");

      const browser = await chromium.launch({
        headless: false,
        args: ["--no-sandbox"],
      });

      const context = await browser.newContext();
      const page = await context.newPage();

      await page.goto(
        "https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement",
        { waitUntil: "domcontentloaded", timeout: 30000 }
      );

      const url = page.url();
      if (!url.includes("signin")) {
        // Already logged in — save and close
        const state = await context.storageState();
        const sessionPath = getSessionPath();
        mkdirSync(dirname(sessionPath), { recursive: true });
        writeFileSync(sessionPath, JSON.stringify(state, null, 2));
        await browser.close();
        ctx.ui.notify("✓ Already logged in! Session saved.", "success");
        return;
      }

      ctx.ui.notify("Please log in — browser will auto-close when done.", "info");

      // Wait for login to complete (URL no longer contains signin)
      await page.waitForURL((u) => !u.toString().includes("signin"), { timeout: 300000 });

      // Save session
      const state = await context.storageState();
      const sessionPath = getSessionPath();
      mkdirSync(dirname(sessionPath), { recursive: true });
      writeFileSync(sessionPath, JSON.stringify(state, null, 2));

      await browser.close();
      ctx.ui.notify("✓ Login complete! Session saved.", "success");
    },
  });

  // ── /volcengine-usage-logout ───────────────────────────────────
  pi.registerCommand("volcengine-usage-logout", {
    description: "Clear saved session",
    handler: async (_args, ctx) => {
      const sessionPath = getSessionPath();
      if (existsSync(sessionPath)) unlinkSync(sessionPath);
      usage = null;
      ctx.ui.notify("✓ Session cleared.", "success");
    },
  });

}
