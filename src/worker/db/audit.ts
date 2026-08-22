export interface AuditContext {
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
  actorIp?: string | null;
  createdAt?: number;
}

export function auditStatement(env: Env, entry: AuditContext): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO audit_logs (
       id, action, entity_type, entity_id, details, actor_ip, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(
    crypto.randomUUID(),
    entry.action,
    entry.entityType,
    entry.entityId ?? null,
    entry.details ? JSON.stringify(entry.details) : null,
    entry.actorIp ?? null,
    entry.createdAt ?? Math.floor(Date.now() / 1000),
  );
}
