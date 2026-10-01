import { MONITOR_WITH_CONTEXT_SELECT, splitMonitorContext, type MonitorWithContextRow } from "./db/check-context";
import { recordCheck } from "./db/record-check";
import { checkMonitor } from "./monitoring/checker";
import { deliverPendingNotifications } from "./notifications/delivery";

const LOCK_SECONDS = 180;
const CHECK_CONCURRENCY = 4;
// Free-plan Workers allow 50 subrequests per invocation, and D1 calls count.
// Reserve: lock, due query, notification select + SMTP connection + update, prune, lock release.
const SUBREQUEST_LIMIT = 50;
const RESERVED_SUBREQUESTS = 8;
// One fetch plus one D1 batch; allow a couple of redirect hops when following redirects.
const CHECK_SUBREQUESTS = 2;
const REDIRECT_SUBREQUESTS = 2;

interface LockRow {
  expires_at: number;
}

export async function runScheduledChecks(env: Env, scheduledTimeMs: number): Promise<void> {
  const now = Math.floor(scheduledTimeMs / 1000);
  const lockExpiresAt = now + LOCK_SECONDS;
  const acquired = await acquireLock(env, now, lockExpiresAt);
  if (!acquired) {
    console.warn(JSON.stringify({ message: "scheduled_check_skipped", reason: "lock_held" }));
    return;
  }

  try {
    const due = await env.DB.prepare(
      `${MONITOR_WITH_CONTEXT_SELECT}
        WHERE m.paused = 0
          AND (s.last_checked_at IS NULL OR s.last_checked_at <= ?1 - m.interval_seconds)
        ORDER BY COALESCE(s.last_checked_at, 0) ASC
        LIMIT 20`,
    )
      .bind(now)
      .all<MonitorWithContextRow>();

    const checks = withinSubrequestBudget(due.results);
    if (checks.length < due.results.length) {
      // Oldest checks run first, so deferred monitors lead the next minute's batch.
      console.warn(JSON.stringify({
        message: "scheduled_checks_deferred",
        due: due.results.length,
        deferred: due.results.length - checks.length,
      }));
    }

    for (let index = 0; index < checks.length; index += CHECK_CONCURRENCY) {
      const batch = checks.slice(index, index + CHECK_CONCURRENCY);
      await Promise.all(
        batch.map(async ({ monitor, context }) => {
          try {
            const result = await checkMonitor(monitor);
            await recordCheck(env, monitor, result, context);
          } catch (error) {
            console.error(
              JSON.stringify({
                message: "monitor_check_recording_failed",
                monitorId: monitor.id,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        }),
      );
    }

    await deliverPendingNotifications(env, Math.floor(Date.now() / 1000));
    if (new Date(scheduledTimeMs).getUTCMinutes() === 0) {
      await pruneOldData(env, now);
    }
  } finally {
    await env.DB.prepare("DELETE FROM runtime_locks WHERE name = 'scheduled' AND expires_at = ?1")
      .bind(lockExpiresAt)
      .run();
  }
}

function withinSubrequestBudget(rows: MonitorWithContextRow[]): ReturnType<typeof splitMonitorContext>[] {
  let remaining = SUBREQUEST_LIMIT - RESERVED_SUBREQUESTS;
  const selected: ReturnType<typeof splitMonitorContext>[] = [];
  for (const row of rows) {
    const cost = CHECK_SUBREQUESTS + (row.follow_redirects === 1 ? REDIRECT_SUBREQUESTS : 0);
    if (cost > remaining) break;
    remaining -= cost;
    selected.push(splitMonitorContext(row));
  }
  return selected;
}

async function acquireLock(env: Env, now: number, expiresAt: number): Promise<boolean> {
  const lock = await env.DB.prepare(
    `INSERT INTO runtime_locks (name, expires_at)
     VALUES ('scheduled', ?1)
     ON CONFLICT(name) DO UPDATE SET expires_at = excluded.expires_at
       WHERE runtime_locks.expires_at < ?2
     RETURNING expires_at`,
  )
    .bind(expiresAt, now)
    .first<LockRow>();
  return lock?.expires_at === expiresAt;
}

async function pruneOldData(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM check_runs WHERE ended_at < ?1").bind(now - 90 * 24 * 60 * 60),
    env.DB.prepare("DELETE FROM metrics_hourly WHERE bucket_start < ?1").bind(
      now - 90 * 24 * 60 * 60,
    ),
    env.DB.prepare("DELETE FROM audit_logs WHERE created_at < ?1").bind(now - 90 * 24 * 60 * 60),
    env.DB.prepare(
      "DELETE FROM notifications WHERE status = 'sent' AND sent_at IS NOT NULL AND sent_at < ?1",
    ).bind(now - 30 * 24 * 60 * 60),
  ]);
}
