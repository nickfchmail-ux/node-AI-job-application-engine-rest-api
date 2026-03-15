import { Browser, BrowserContext, chromium } from "playwright";

// Docker/Railway require these args; harmless on local.
const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--no-zygote",
  "--disable-gpu",
];

const CONTEXT_OPTIONS = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  locale: "en-US",
  viewport: { width: 1280, height: 800 } as const,
};

/**
 * Singleton Playwright browser pool.
 *
 * Why: launching a new Chromium process per scraper/enrich run costs ~300 MB
 * and 3-5 s of cold-start time. With a pool, one browser process is shared
 * across all concurrent pipeline runs via isolated BrowserContexts.
 *
 * Capacity (MAX_CONTEXTS): limits how many contexts exist simultaneously so
 * memory stays bounded. Callers that exceed the cap are queued and unblocked
 * as soon as an existing context is released.
 */
const MAX_CONTEXTS = 12; // tune based on available RAM (~80 MB per context)

class BrowserPool {
  private browser: Browser | null = null;
  private launchPromise: Promise<Browser> | null = null;
  private active = 0;
  private readonly max: number;
  private waiters: Array<() => void> = [];

  constructor(max = MAX_CONTEXTS) {
    this.max = max;
  }

  // Lazily launch (or reuse) a single shared browser.
  // The launchPromise guard prevents concurrent calls from spawning multiple
  // Chromium processes during the async launch window.
  private getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return Promise.resolve(this.browser);

    if (!this.launchPromise) {
      // Support optional proxy for Playwright via PLAYWRIGHT_PROXY env var.
      // Example: http://username:password@host:port or host:port
      const proxyRaw = process.env.PLAYWRIGHT_PROXY;
      const proxyOption:
        | { server: string; username?: string; password?: string }
        | undefined = proxyRaw
        ? (() => {
            try {
              // If user supplied a full URL, use it directly.
              if (/^https?:\/\//i.test(proxyRaw)) {
                const u = new URL(proxyRaw);
                const server = `${u.protocol}//${u.hostname}:${u.port || 80}`;
                return {
                  server,
                  username: u.username || undefined,
                  password: u.password || undefined,
                };
              }
              // Otherwise assume host:port (optional username/password in env)
              const server = proxyRaw.includes(":")
                ? `http://${proxyRaw}`
                : `http://${proxyRaw}:80`;
              return {
                server,
                username: process.env.PLAYWRIGHT_PROXY_USERNAME || undefined,
                password: process.env.PLAYWRIGHT_PROXY_PASSWORD || undefined,
              };
            } catch {
              return undefined;
            }
          })()
        : undefined;

      const launchOpts: Parameters<typeof chromium.launch>[0] = {
        headless: true,
        args: LAUNCH_ARGS,
      };
      if (proxyOption) {
        // Playwright expects a `proxy` option on launch
        (launchOpts as any).proxy = {
          server: proxyOption.server,
          username: proxyOption.username,
          password: proxyOption.password,
        };
        console.log(
          `[browserPool] Using Playwright proxy: ${proxyOption.server}`,
        );
      }

      this.launchPromise = chromium
        .launch(launchOpts)
        .then((b) => {
          this.browser = b;
          this.launchPromise = null;
          b.on("disconnected", () => {
            this.browser = null;
          });
          return b;
        })
        .catch((err) => {
          this.launchPromise = null;
          throw err;
        });
    }
    return this.launchPromise;
  }

  /** Acquire an isolated BrowserContext. Queues if the pool is at capacity. */
  async acquire(): Promise<BrowserContext> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    const browser = await this.getBrowser();
    return browser.newContext(CONTEXT_OPTIONS);
  }

  /** Close the context and hand the slot to the next waiter (if any). */
  async release(ctx: BrowserContext): Promise<void> {
    await ctx.close();
    const next = this.waiters.shift();
    if (next) {
      next(); // transfer slot — active count unchanged
    } else {
      this.active--;
    }
  }

  /**
   * Close the shared browser entirely and reset pool state.
   * Call between jobs to reclaim Chromium memory (~200 MB) so the next
   * job starts fresh with the full RAM budget available.
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.launchPromise = null;
    this.active = 0;
    // Drain any waiters — they'll re-queue when acquire() is called next
    this.waiters.forEach((resolve) => resolve());
    this.waiters = [];
  }
}

export const browserPool = new BrowserPool();
