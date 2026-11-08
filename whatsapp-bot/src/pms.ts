// Read-only access to the CDF PMS server's JSON API (the live portfolio page), on this PC by default.

const TIMEOUT_MS = 150_000; // the PMS can take up to ~2 minutes when it has to fetch Bloomberg first

function scalars(o: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!o || typeof o !== "object") return out;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) out[k] = typeof v === "number" ? Math.round(v * 100) / 100 : v;
  }
  return out;
}

function groupName(g: Record<string, unknown>): string {
  for (const k of ["name", "label", "group", "code", "bbg_code", "und_code"]) if (typeof g[k] === "string" && g[k]) return String(g[k]);
  return "";
}

export class Pms {
  constructor(private baseUrl: string, private fetchImpl: typeof fetch = fetch) {}

  private async get(path: string): Promise<any> {
    const res = await this.fetchImpl(this.baseUrl.replace(/\/$/, "") + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`The PMS answered ${res.status} for ${path}.`);
    return res.json();
  }

  /**
   * The portfolio page in compact form: totals, the P&L cut-off, and every group's figures, largest P&L moves first.
   * With `group`, also the individual lines of groups whose name contains that text.
   */
  async portfolio(group?: string): Promise<unknown> {
    const p = await this.get("/api/portfolio");
    const groups = (Array.isArray(p.groups) ? p.groups : []) as Record<string, unknown>[];
    const wanted = group?.trim().toLowerCase();
    const compact = groups
      .map((g) => {
        const out: Record<string, unknown> = { ...scalars(g), name: groupName(g) };
        if (wanted && groupName(g).toLowerCase().includes(wanted) && Array.isArray(g.rows)) out.rows = (g.rows as unknown[]).map(scalars);
        return out;
      })
      .sort((a, b) => Math.abs(Number(b.pnl_us ?? 0)) - Math.abs(Number(a.pnl_us ?? 0)));
    return {
      as_of: p.as_of,
      nav: p.nav,
      pnl_cutoff: p.pnl_cutoff,
      totals: scalars(p.totals),
      bloomberg: scalars(p.bloomberg),
      ib_live: p.ib_live && typeof p.ib_live === "object" ? scalars(p.ib_live) : p.ib_live,
      issues: Array.isArray(p.issues) ? p.issues.length : p.issues,
      groups: compact,
      note: "pnl_us = P&L in US$ since the last US close (the page's 'P&L $ since US close'). day_pnl_usd = IB's own daily P&L from its latest statement, which lags 1-2 business days.",
    };
  }

  /** NAV, NAV per share by class, value by counterparty, freshness. */
  async summary(): Promise<unknown> {
    return this.get("/api/summary");
  }
}
