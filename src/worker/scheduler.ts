import { recordCheck } from "./db/record-check";
import type { MonitorRow } from "./db/types";
import { checkMonitor } from "./monitoring/checker";
import { deliverPendingNotifications } from "./notifications/delivery";

const LOCK_SECONDS = 180;
const CHECK_CONCURRENCY = 4;

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
      `SELECT m.id, m.name, m.url, m.method, m.expected_status_min,
              m.expected_status_max, m.expected_keyword, m.timeout_ms,
              m.interval_seconds, m.follow_redirects, m.paused,
              m.created_at, m.updated_at
         FROM monitors m
         LEFT JOIN monitor_state s ON s.monitor_id = m.id
        WHERE m.paused = 0
          AND (s.last_checked_at IS NULL OR s.last_checked_at <= ?1 - m.interval_seconds)
        ORDER BY COALESCE(s.last_checked_at, 0) ASC
        LIMIT 20`,
    )
      .bind(now)
      .all<MonitorRow>();

    for (let index = 0; index < due.results.length; index += CHECK_CONCURRENCY) {
      const batch = due.results.slice(index, index + CHECK_CONCURRENCY);
      await Promise.all(
        batch.map(async (monitor) => {
          try {
            const result = await checkMonitor(monitor);
            await recordCheck(env, monitor, result);
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
    env.DB.prepare("DELETE FROM metrics_hourly WHERE bucket_start < ?1").bind(
      now - 90 * 24 * 60 * 60,
    ),
    env.DB.prepare("DELETE FROM audit_logs WHERE created_at < ?1").bind(now - 90 * 24 * 60 * 60),
    env.DB.prepare(
      "DELETE FROM notifications WHERE status = 'sent' AND sent_at IS NOT NULL AND sent_at < ?1",
    ).bind(now - 30 * 24 * 60 * 60),
  ]);
}
