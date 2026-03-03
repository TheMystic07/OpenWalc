export type TokenMarketStatus = "prelaunch" | "live" | "no_pair" | "error";

export interface TokenMarketConfig {
  ca: string;
  chain: string;
  ttlMs: number;
  timeoutMs: number;
}

export interface TokenMarketSnapshot {
  status: TokenMarketStatus;
  priceUsd: number | null;
  change24h: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidityUsd: number | null;
  source: string | null;
  sourceUrl: string | null;
  message?: string;
  cachedAt: number;
}

interface CacheState {
  expiresAt: number;
  snapshot: TokenMarketSnapshot;
}

interface PairCandidate {
  priceUsd?: unknown;
  priceChange?: { h24?: unknown };
  marketCap?: unknown;
  fdv?: unknown;
  liquidity?: { usd?: unknown };
  url?: unknown;
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isPlaceholderCa(ca: string): boolean {
  const normalized = ca.trim();
  if (!normalized) return true;
  return /^REPLACE_/i.test(normalized);
}

function normalizePairToSnapshot(
  pair: PairCandidate,
  source: string,
  cachedAt: number,
): TokenMarketSnapshot | null {
  const priceUsd = toFiniteNumber(pair.priceUsd);
  if (priceUsd === null || priceUsd <= 0) return null;
  return {
    status: "live",
    priceUsd,
    change24h: toFiniteNumber(pair.priceChange?.h24),
    marketCap: toFiniteNumber(pair.marketCap),
    fdv: toFiniteNumber(pair.fdv),
    liquidityUsd: toFiniteNumber(pair.liquidity?.usd),
    source,
    sourceUrl: typeof pair.url === "string" ? pair.url : null,
    cachedAt,
  };
}

function byLiquidityDesc(left: PairCandidate, right: PairCandidate): number {
  const leftLiq = toFiniteNumber(left?.liquidity?.usd) ?? 0;
  const rightLiq = toFiniteNumber(right?.liquidity?.usd) ?? 0;
  return rightLiq - leftLiq;
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export class TokenMarketService {
  private cache: CacheState | null = null;

  constructor(private readonly config: TokenMarketConfig) {}

  isPlaceholder(): boolean {
    return isPlaceholderCa(this.config.ca);
  }

  async getSnapshot(force = false): Promise<TokenMarketSnapshot> {
    const now = Date.now();
    if (!force && this.cache && this.cache.expiresAt > now) {
      return this.cache.snapshot;
    }

    const snapshot = await this.fetchFreshSnapshot(now);
    this.cache = {
      expiresAt: now + Math.max(1000, this.config.ttlMs),
      snapshot,
    };
    return snapshot;
  }

  private async fetchFreshSnapshot(cachedAt: number): Promise<TokenMarketSnapshot> {
    if (this.isPlaceholder()) {
      return {
        status: "prelaunch",
        priceUsd: null,
        change24h: null,
        marketCap: null,
        fdv: null,
        liquidityUsd: null,
        source: null,
        sourceUrl: null,
        message: "token_ca_placeholder",
        cachedAt,
      };
    }

    const primary = await this.fetchFromDexLatest(cachedAt);
    if (primary) return primary;

    const fallback = await this.fetchFromDexPairsV1(cachedAt);
    if (fallback) return fallback;

    return {
      status: "error",
      priceUsd: null,
      change24h: null,
      marketCap: null,
      fdv: null,
      liquidityUsd: null,
      source: null,
      sourceUrl: null,
      message: "market_feed_unavailable",
      cachedAt,
    };
  }

  private async fetchFromDexLatest(cachedAt: number): Promise<TokenMarketSnapshot | null> {
    try {
      const payload = (await fetchJsonWithTimeout(
        `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(this.config.ca)}`,
        this.config.timeoutMs,
      )) as { pairs?: PairCandidate[] };

      const pairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
      if (pairs.length === 0) {
        return {
          status: "no_pair",
          priceUsd: null,
          change24h: null,
          marketCap: null,
          fdv: null,
          liquidityUsd: null,
          source: "dexscreener-latest",
          sourceUrl: null,
          message: "no_pairs",
          cachedAt,
        };
      }

      const mostLiquid = [...pairs].sort(byLiquidityDesc)[0];
      return normalizePairToSnapshot(mostLiquid, "dexscreener-latest", cachedAt);
    } catch {
      return null;
    }
  }

  private async fetchFromDexPairsV1(cachedAt: number): Promise<TokenMarketSnapshot | null> {
    try {
      const payload = await fetchJsonWithTimeout(
        `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(this.config.chain)}/${encodeURIComponent(this.config.ca)}`,
        this.config.timeoutMs,
      );
      const pairs = Array.isArray(payload) ? (payload as PairCandidate[]) : [];
      if (pairs.length === 0) {
        return {
          status: "no_pair",
          priceUsd: null,
          change24h: null,
          marketCap: null,
          fdv: null,
          liquidityUsd: null,
          source: "dexscreener-v1",
          sourceUrl: null,
          message: "no_pairs",
          cachedAt,
        };
      }
      const mostLiquid = [...pairs].sort(byLiquidityDesc)[0];
      return normalizePairToSnapshot(mostLiquid, "dexscreener-v1", cachedAt);
    } catch {
      return null;
    }
  }
}
