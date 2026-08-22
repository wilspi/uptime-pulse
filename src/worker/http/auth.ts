import type { Context, Next } from "hono";

export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  const authorization = c.req.header("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token || !(await constantTimeEqual(token, c.env.ADMIN_TOKEN))) {
    console.warn(
      JSON.stringify({
        message: "admin_auth_failed",
        path: c.req.path,
        actorIp: c.req.header("CF-Connecting-IP") ?? null,
      }),
    );
    return c.json({ error: "Unauthorized" }, 401, {
      "WWW-Authenticate": "Bearer",
    });
  }
  await next();
}

async function constantTimeEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const providedBytes = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < providedBytes.length; index += 1) {
    difference |= providedBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}
