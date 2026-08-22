import { sendSmtpMail, SmtpError } from "./smtp";

interface NotificationRow {
  id: string;
  kind: "down" | "recovered" | "test";
  subject: string;
  body: string;
  attempts: number;
}

const RETRY_DELAYS = [60, 300, 900, 3600, 14_400] as const;

export async function deliverPendingNotifications(env: Env, now: number): Promise<void> {
  const pending = await env.DB.prepare(
    `SELECT id, kind, subject, body, attempts
       FROM notifications
      WHERE status = 'pending' AND next_attempt_at <= ?1
      ORDER BY created_at ASC
      LIMIT 1`,
  )
    .bind(now)
    .all<NotificationRow>();

  for (const notification of pending.results) {
    await deliverNotification(env, notification, now);
  }
}

async function deliverNotification(
  env: Env,
  notification: NotificationRow,
  now: number,
): Promise<void> {
  try {
    await sendSmtpMail(env, {
      kind: notification.kind,
      subject: notification.subject,
      body: notification.body,
    });
    await env.DB.prepare(
      `UPDATE notifications
          SET status = 'sent', attempts = attempts + 1, sent_at = ?1, last_error = NULL
        WHERE id = ?2`,
    )
      .bind(now, notification.id)
      .run();
    console.log(
      JSON.stringify({
        message: "notification_sent",
        notificationId: notification.id,
        kind: notification.kind,
      }),
    );
  } catch (error) {
    const attempts = notification.attempts + 1;
    const permanent = error instanceof SmtpError && error.permanent;
    const exhausted = attempts >= RETRY_DELAYS.length;
    const status = permanent || exhausted ? "failed" : "pending";
    const delay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)];
    const detail = error instanceof Error ? error.message.slice(0, 500) : "Unknown SMTP error";

    await env.DB.prepare(
      `UPDATE notifications
          SET status = ?1, attempts = ?2, next_attempt_at = ?3, last_error = ?4
        WHERE id = ?5`,
    )
      .bind(status, attempts, now + delay, detail, notification.id)
      .run();
    console.error(
      JSON.stringify({
        message: "notification_failed",
        notificationId: notification.id,
        kind: notification.kind,
        attempts,
        permanent,
        error: detail,
      }),
    );
  }
}
