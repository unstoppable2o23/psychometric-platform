/**
 * Fixed-window rate limiter.
 *
 * In-process and therefore per-instance. That is enough to blunt credential
 * stuffing, link enumeration, and autosave floods on a single server, and it has
 * no operational cost. It is explicitly NOT a distributed limit: on a multi-
 * instance deployment each instance keeps its own window, so the effective limit
 * is N times the configured value. Swapping the backing store for Redis is the
 * only change needed to make it cluster-wide.
 *
 * Counters are swept lazily on write, so an idle key costs nothing and the map
 * cannot grow without bound.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Keys are swept when the map grows past this, keeping memory bounded. */
const SWEEP_THRESHOLD = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window rolls over. */
  retryAfterSeconds: number;
}

export function rateLimit(key: string, limit: number, windowMs = 60_000): RateLimitResult {
  const now = Date.now();

  if (buckets.size > SWEEP_THRESHOLD) {
    for (const [k, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(k);
    }
  }

  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }

  existing.count += 1;
  const allowed = existing.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - existing.count),
    retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

/**
 * Best-effort client identity.
 *
 * Trusts `x-forwarded-for` only as far as taking the left-most entry, which is
 * the client when the request arrived through a proxy. On a deployment that is
 * reachable directly, a client can forge this header, so it raises the limit
 * rather than lowering it. It must never be the basis for a security decision.
 */
export function clientKeyFromHeaders(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return `ip:${first}`;
  }
  return `ip:${headers.get('x-real-ip') ?? 'unknown'}`;
}

/** Test-only reset so suites do not leak counters into each other. */
export function resetRateLimits(): void {
  buckets.clear();
}
