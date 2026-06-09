import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
  let footerOn = false;
  let _tui: any = null;
  let thinkingLevel = "off";
  let footerCtx: any = null;

  function formatTokens(count: number): string {
    if (count < 1000) return String(count);
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1e6) return `${Math.round(count / 1000)}k`;
    if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
    return `${Math.round(count / 1e6)}M`;
  }

  function trigger() { if (_tui) setTimeout(() => _tui.requestRender?.(), 0); }

  // ── Footer (only shows cached data — no auto-fetch) ────────
  function buildFooter() {
    const ctx = footerCtx;
    return (tui: any, theme: any, fd: any) => {
      _tui = tui;
      const unsub = fd.onBranchChange(() => tui.requestRender());
      return {
        dispose: () => { unsub(); _tui = null; },
        invalidate() {},
        render(width: number): string[] {
          const sm = ctx.sessionManager;

          // ── Line 1: pwd ──────────────────────────────────
          const home = process.env.HOME || process.env.USERPROFILE || "";
          let pwd = ctx.cwd || sm.getCwd?.() || "";
          if (home && pwd.startsWith(home)) pwd = "~" + pwd.slice(home.length);
          const branch = fd.getGitBranch();
          if (branch) pwd += ` (${branch})`;
          const sname = sm.getSessionName?.();
          if (sname) pwd += ` • ${sname}`;
          const ln1 = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

          // ── Line 2: stats ────────────────────────────────
          let ti = 0, to = 0, tc = 0;
          for (const e of sm.getEntries()) {
            if (e.type === "message" && e.message?.role === "assistant") {
              const u = (e.message as AssistantMessage).usage;
              ti += u.input; to += u.output;
              tc += u.cost.total;
            }
          }
          const parts: string[] = [];
          if (ti) parts.push(`↑${formatTokens(ti)}`);
          if (to) parts.push(`↓${formatTokens(to)}`);
          if (tc) parts.push(`$${tc.toFixed(3)}`);

          // Volcengine Coding Plan usage (cached data only)
          if (usage) {
            for (const q of usage.quotas) {
              if (q.resetTimestamp <= 0) continue; // skip no active window
              const label = LEVEL_LABELS[q.level] || q.level;
              const sev = usageSeverity(q.percent, q.level, q.resetTimestamp);
              const flag = sev === 2 ? "!!" : sev === 1 ? "!" : "";
              parts.push(`${flag}${label}:${Math.round(q.percent * 10) / 10}%`);
            }
          }

          let left = parts.join(" ");

          // Right side: model info
          const m = ctx.model;
          let right = m?.id || "no-model";
          if (m?.reasoning) {
            const tl = thinkingLevel;
            right = tl === "off" ? `${right} • thinking off` : `${right} • ${tl}`;
          }
          const withProv = `(volcengine-plan) ${right}`;
          if (visibleWidth(left) + 2 + visibleWidth(withProv) <= width) {
            right = withProv;
          }

          const lw = visibleWidth(left);
          const rw = visibleWidth(right);

          let ln2: string;
          if (lw + 2 + rw <= width) {
            ln2 = left + " ".repeat(width - lw - rw) + right;
          } else if (lw + 2 < width) {
            ln2 = truncateToWidth(left + "  " + right, width, "");
          } else {
            ln2 = truncateToWidth(left, width, "...");
          }

          return [ln1, theme.fg("dim", ln2)];
        },
      };
    };
  }

  function updateFooter(ctx: any) {
    footerCtx = ctx;
    if (!footerOn) {
      ctx.ui.setFooter(buildFooter());
      footerOn = true;
    } else {
      trigger();
    }
  }

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
          if (q.resetTimestamp > 0) {
            const sev = usageSeverity(pct, q.level, q.resetTimestamp);
            const flag = sev === 2 ? "!!" : sev === 1 ? "!" : "";
            const resetStr = humanDuration(q.resetTimestamp * 1000 - Date.now());
            lines.push(`${flag}${label}  ${bar}  ${pct}%  resets ${resetStr}`);
          } else {
            lines.push(`${label}  ${bar}  ${pct}%  (no active window)`);
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
        // Update footer with fresh data
        updateFooter(ctx);
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
      if (footerOn) {
        ctx.ui.setFooter(undefined as any);
        footerOn = false;
        _tui = null;
        footerCtx = null;
      }
      ctx.ui.notify("✓ Session cleared.", "success");
    },
  });

}
