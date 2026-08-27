// ============================================================
//  Authoritative server-side usage tracking + enforcement.
//
//  The frontend ALSO checks usage (lib/entitlements.ts) to disable
//  buttons, but recording must happen HERE so the backend is the
//  single writer. The scrape trigger calls `consumeUsage("search")`
//  before enqueueing a scrape job.
//
//  Race safety: free-tier per-key limits use a PARTIAL UNIQUE INDEX
//  on (user_id, usage_type, search_key) WHERE plan='free' — a
//  concurrent double-click hits 23505 and is rejected. Paid monthly
//  limits count rows (multiple rows per key allowed so re-searching
//  the same keyword advances to the next page).
//
//  Quota model (mirrors lib/entitlements.ts):
//    free     : 1 search + 1 eval per key, 1 fine-tune each (lifetime)
//    standard : 150 HKD/mo — 30 each
//    pro      : 300 HKD/mo — 70 each
//    admin    : unlimited
// ============================================================

import { getSupabaseClient } from "./supabase";

export type UsageType =
  | "search"
  | "evaluation"
  | "fine_tune_resume"
  | "fine_tune_cover_letter";

export type UsageResult =
  | { ok: true; id?: string | null }
  | { ok: false; reason: "not_found" | "limit_reached"; message: string };

const FREE_SEARCH_LIMIT = 1; // lifetime, TOTAL (not per-key)
const FREE_EVALUATION_LIMIT = 1; // lifetime, TOTAL (not per-key)
const FREE_FINE_TUNE_LIMIT = 1;

const PLAN_LIMITS: Record<
  string,
  {
    searches: number;
    evaluations: number;
    fineTuneResume: number;
    fineTuneCoverLetter: number;
  }
> = {
  standard: {
    searches: 30,
    evaluations: 30,
    fineTuneResume: 30,
    fineTuneCoverLetter: 30,
  },
  pro: {
    searches: 70,
    evaluations: 70,
    fineTuneResume: 70,
    fineTuneCoverLetter: 70,
  },
};

function normalizeKey(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}

/** Fetch the user's profile row, lazily CREATING a default free profile if absent. */
export async function getProfileForUser(userId: string) {
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from("profiles")
    .select(
      "role, plan, subscription_status, usage_period_start, current_period_end",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load profile: ${error.message}`);
  }
  if (data) {
    return data as {
      role: string | null;
      plan: string | null;
      subscription_status: string | null;
      usage_period_start: string | null;
      current_period_end: string | null;
    };
  }
  // No profile yet (brand-new user who never opened the Profile page) →
  // create a default free profile so their first action isn't blocked.
  const now = new Date().toISOString();
  const { data: created, error: createErr } = await sb
    .from("profiles")
    .insert({
      user_id: userId,
      role: "user",
      plan: "free",
      subscription_status: "none",
      usage_period_start: now,
    })
    .select(
      "role, plan, subscription_status, usage_period_start, current_period_end",
    )
    .maybeSingle();
  if (createErr && createErr.code !== "23505") {
    throw new Error(`Failed to create profile: ${createErr.message}`);
  }
  if (created) {
    return created as {
      role: string | null;
      plan: string | null;
      subscription_status: string | null;
      usage_period_start: string | null;
      current_period_end: string | null;
    };
  }
  // A concurrent insert won — re-read.
  const { data: retry } = await sb
    .from("profiles")
    .select(
      "role, plan, subscription_status, usage_period_start, current_period_end",
    )
    .eq("user_id", userId)
    .maybeSingle();
  return (retry ?? null) as {
    role: string | null;
    plan: string | null;
    subscription_status: string | null;
    usage_period_start: string | null;
    current_period_end: string | null;
  } | null;
}

function isActive(status: string | null | undefined): boolean {
  return (
    status === "active" ||
    status === "trialing" ||
    status === "past_due" ||
    status === "paused"
  );
}

async function countUsage(
  userId: string,
  type: UsageType,
  periodStart: string,
  searchKey?: string,
): Promise<number> {
  const sb = getSupabaseClient();
  let q = sb
    .from("usage_records")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("usage_type", type)
    .gte("created_at", periodStart);
  if (searchKey) q = q.eq("search_key", searchKey);
  const { count, error } = await q;
  if (error) throw new Error(`Failed to count usage: ${error.message}`);
  return count ?? 0;
}

/** Sentinel so callers can distinguish a race-limit from a hard error. */
export class UsageLimitReachedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageLimitReachedError";
  }
}

/** Insert a usage row, returning its id. Throws UsageLimitReachedError on a unique violation. */
async function insertUsage(
  userId: string,
  type: UsageType,
  searchKey: string | null,
  plan: string,
): Promise<string | null> {
  const { data, error } = await getSupabaseClient()
    .from("usage_records")
    .insert({
      user_id: userId,
      usage_type: type,
      search_key: type === "search" || type === "evaluation" ? searchKey : null,
      plan,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new UsageLimitReachedError(
        "You've just hit your limit. Upgrade to Standard or Pro for more.",
      );
    }
    throw new Error(`Failed to record usage: ${error.message}`);
  }
  return (data?.id as string | null) ?? null;
}

/**
 * Enforce the user's plan limit for `type` and, if allowed, record a
 * `usage_records` row (the deduction). Stamps the effective plan so the
 * partial unique index (plan='free') enforces free per-key limits.
 */
export async function consumeUsage(
  userId: string,
  type: UsageType,
  opts?: { searchKey?: string | null },
): Promise<UsageResult> {
  const profile = await getProfileForUser(userId);
  if (!profile) {
    return { ok: false, reason: "not_found", message: "Profile not found." };
  }

  if (profile.role === "admin") {
    const id = await insertUsage(
      userId,
      type,
      opts?.searchKey ?? null,
      "admin",
    );
    await bumpLedger(userId, type).catch(() => {});
    return { ok: true, id };
  }

  const plan = profile.plan ?? "free";
  const active = isActive(profile.subscription_status);
  const effectivePlan = plan !== "free" && !active ? "free" : plan;

  const periodStart = profile.usage_period_start ?? new Date().toISOString();
  const key = normalizeKey(opts?.searchKey) || "general";

  switch (type) {
    case "search": {
      if (effectivePlan === "free") {
        const used = await countUsage(userId, "search", periodStart);
        if (used >= FREE_SEARCH_LIMIT)
          return {
            ok: false,
            reason: "limit_reached",
            message:
              "You've used your free search. Upgrade to Standard or Pro for more.",
          };
      } else {
        const max = PLAN_LIMITS[effectivePlan]?.searches ?? 0;
        const used = await countUsage(userId, "search", periodStart);
        if (used >= max)
          return {
            ok: false,
            reason: "limit_reached",
            message: `You've used all ${max} searches for this month. They reset next billing cycle.`,
          };
      }
      break;
    }
    case "evaluation": {
      if (effectivePlan === "free") {
        const used = await countUsage(userId, "evaluation", periodStart);
        if (used >= FREE_EVALUATION_LIMIT)
          return {
            ok: false,
            reason: "limit_reached",
            message:
              "You've used your free evaluation. Upgrade to Standard or Pro for more.",
          };
      } else {
        const max = PLAN_LIMITS[effectivePlan]?.evaluations ?? 0;
        const used = await countUsage(userId, "evaluation", periodStart);
        if (used >= max)
          return {
            ok: false,
            reason: "limit_reached",
            message: `You've used all ${max} evaluations for this month. They reset next billing cycle.`,
          };
      }
      break;
    }
    case "fine_tune_resume": {
      const max =
        effectivePlan === "free"
          ? FREE_FINE_TUNE_LIMIT
          : (PLAN_LIMITS[effectivePlan]?.fineTuneResume ?? 0);
      const used = await countUsage(userId, "fine_tune_resume", periodStart);
      if (used >= max)
        return {
          ok: false,
          reason: "limit_reached",
          message:
            effectivePlan === "free"
              ? "You've used your free resume fine-tune. Upgrade to Standard or Pro for more."
              : `You've used all ${max} resume fine-tunes for this month. They reset next billing cycle.`,
        };
      break;
    }
    case "fine_tune_cover_letter": {
      const max =
        effectivePlan === "free"
          ? FREE_FINE_TUNE_LIMIT
          : (PLAN_LIMITS[effectivePlan]?.fineTuneCoverLetter ?? 0);
      const used = await countUsage(
        userId,
        "fine_tune_cover_letter",
        periodStart,
      );
      if (used >= max)
        return {
          ok: false,
          reason: "limit_reached",
          message:
            effectivePlan === "free"
              ? "You've used your free cover-letter fine-tune. Upgrade to Standard or Pro for more."
              : `You've used all ${max} cover-letter fine-tunes for this month. They reset next billing cycle.`,
        };
      break;
    }
  }

  const id = await insertUsage(userId, type, key, effectivePlan);
  await bumpLedger(userId, type).catch(() => {});
  return { ok: true, id };
}

/** Undo a deduction when the downstream operation failed (last 2 minutes only). */
export async function refundUsage(
  userId: string,
  type: UsageType,
  searchKey?: string | null,
): Promise<void> {
  const key = normalizeKey(searchKey) || "general";
  const now = new Date();
  await getSupabaseClient()
    .from("usage_records")
    .delete()
    .eq("user_id", userId)
    .eq("usage_type", type)
    .eq("search_key", type === "search" || type === "evaluation" ? key : null)
    .gte("created_at", new Date(now.getTime() - 120_000).toISOString())
    .lte("created_at", new Date(now.getTime() + 5_000).toISOString());
  await decrementLedger(userId, type);
}

/**
 * Undo a deduction by its EXACT usage_records row id — no time-window
 * dependence, so a worker can refund a search that ran for minutes and then
 * failed (all boards unreachable → 0 jobs). Also decrements the ledger.
 */
export async function refundUsageById(
  usageId: string,
  userId: string,
  type: UsageType,
): Promise<void> {
  if (!usageId) return;
  const { data, error } = await getSupabaseClient()
    .from("usage_records")
    .delete()
    .eq("id", usageId)
    .eq("user_id", userId)
    .eq("usage_type", type)
    .select("id");
  if (error) {
    console.warn(
      `[usage] refundUsageById(${usageId}) failed: ${error.message}`,
    );
    return;
  }
  if (data && data.length > 0) {
    await decrementLedger(userId, type);
    console.info(`[usage] refunded usage row ${usageId} (${type})`);
  }
}

/**
 * Increment the user's `entitlements` ledger used-counter for `type`.
 * Lazily creates the ledger row (default free) if it doesn't exist yet.
 * Non-fatal — the `usage_records` insert is the source of truth; if the
 * ledger bump fails we log and continue.
 */
export async function bumpLedger(
  userId: string,
  type: UsageType,
): Promise<void> {
  const column = ledgerColumnFor(type);
  if (!column) return;
  const sb = getSupabaseClient();
  await ensureLedgerRow(userId);
  const { error } = await sb.rpc("bump_entitlement", {
    p_user_id: userId,
    p_column: column,
  });
  if (error) {
    console.warn(`[usage] ledger bump failed (${column}): ${error.message}`);
  }
}

/** Decrement the ledger used-counter (used on refund). Non-fatal. */
export async function decrementLedger(
  userId: string,
  type: UsageType,
): Promise<void> {
  const column = ledgerColumnFor(type);
  if (!column) return;
  const { error } = await getSupabaseClient().rpc("bump_entitlement", {
    p_user_id: userId,
    p_column: column,
    p_delta: -1,
  });
  if (error) {
    console.warn(
      `[usage] ledger decrement failed (${column}): ${error.message}`,
    );
  }
}

/** Map a usage type to its ledger used_* column. */
function ledgerColumnFor(type: UsageType): string | null {
  switch (type) {
    case "search":
      return "used_searches";
    case "evaluation":
      return "used_evaluations";
    case "fine_tune_resume":
      return "used_fine_tune_resume";
    case "fine_tune_cover_letter":
      return "used_fine_tune_cover";
    default:
      return null;
  }
}

/** Ensure an entitlements ledger row exists (lazy create, default free). */
async function ensureLedgerRow(userId: string): Promise<void> {
  const { data, error } = await getSupabaseClient()
    .from("entitlements")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || data) return;
  const now = new Date().toISOString();
  const { error: insertErr } = await getSupabaseClient()
    .from("entitlements")
    .insert({
      user_id: userId,
      plan: "free",
      // Free plan privileges: 1 each.
      allowed_searches: 1,
      allowed_evaluations: 1,
      allowed_fine_tune_resume: 1,
      allowed_fine_tune_cover: 1,
      used_searches: 0,
      used_evaluations: 0,
      used_fine_tune_resume: 0,
      used_fine_tune_cover: 0,
      period_started_at: now,
    });
  if (insertErr && insertErr.code !== "23505") {
    console.warn(`[usage] ledger row create failed: ${insertErr.message}`);
  }
}

/** Record usage without a limit check (unlimited users / re-assertion). */
export async function recordUsage(
  userId: string,
  type: UsageType,
  searchKey?: string | null,
  plan = "free",
): Promise<void> {
  const key = normalizeKey(searchKey) || "general";
  await getSupabaseClient()
    .from("usage_records")
    .insert({
      user_id: userId,
      usage_type: type,
      search_key: type === "search" || type === "evaluation" ? key : null,
      plan,
    });
}

/**
 * Record usage for a RETRY that succeeded, stamping the user's EFFECTIVE plan
 * (so a Standard/Pro retry counts against their monthly quota correctly, and
 * a free retry is recorded as free). Best-effort: never throws.
 */
export async function recordRetryUsage(
  userId: string,
  type: UsageType,
  searchKey?: string | null,
): Promise<void> {
  try {
    let plan = "free";
    const profile = await getProfileForUser(userId);
    if (profile) {
      const active = isActive(profile.subscription_status);
      const effectivePlan =
        profile.plan && profile.plan !== "free" && !active
          ? "free"
          : (profile.plan ?? "free");
      plan = effectivePlan;
    }
    await recordUsage(userId, type, searchKey, plan);
  } catch (err) {
    console.warn(`[usage] recordRetryUsage failed: ${err}`);
  }
}
