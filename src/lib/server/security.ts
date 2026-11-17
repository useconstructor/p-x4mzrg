import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { type Connection, now, one, run, uuid } from "./database";
import { ApiError, invalid } from "./errors";

export type Actor = { type: "visitor" | "owner"; id: string; csrfToken: string; tokenHash: string };
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const cookieName = (type: Actor["type"]) => type === "visitor" ? "raiz_visitor" : "raiz_owner";
const lifetime = 30 * 24 * 60 * 60;
export function trustedOrigins(): string[] {
  const values = [process.env.APP_ORIGIN, process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL.replace(/^https?:\/\//, "")}` : undefined];
  return values.flatMap(value => {
    if (!value) return [];
    try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) ? [u.origin] : []; } catch { return []; }
  });
}
export function requireOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin || !trustedOrigins().includes(origin)) throw new ApiError(403, "ORIGIN_FORBIDDEN", "Abre Raíz desde su dirección autorizada e inténtalo de nuevo.");
}
function equal(a: string, b: string) {
  return timingSafeEqual(Buffer.from(hash(a), "hex"), Buffer.from(hash(b), "hex"));
}
export async function actor(c: Connection, request: NextRequest, type: Actor["type"], required = true): Promise<Actor | null> {
  const token = request.cookies.get(cookieName(type))?.value;
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    const tokenHash = hash(token);
    const record = await one(c, "SELECT actor_id FROM raiz_auth_sessions WHERE token_hash=? AND actor_type=? AND expires_at>?", [tokenHash, type, now()]);
    if (record) return { type, id: String(record.actor_id), tokenHash, csrfToken: hash(`raiz-csrf:${token}`) };
  }
  if (required) throw new ApiError(401, "SESSION_REQUIRED", type === "owner" ? "Inicia sesión para administrar Raíz." : "No podemos comprobar tu sesión. Recupera el acceso antes de continuar.");
  return null;
}
export function requireCsrf(request: NextRequest, actor: Actor) {
  const supplied = request.headers.get("x-csrf-token");
  if (!supplied || !equal(supplied, actor.csrfToken)) throw new ApiError(403, "CSRF_INVALID", "Actualiza tu sesión antes de volver a confirmar.");
}
export async function createSession(c: Connection, type: Actor["type"], actorId?: string) {
  const token = randomBytes(32).toString("hex");
  const id = actorId ?? uuid();
  const at = now();
  if (type === "visitor") await run(c, "INSERT INTO raiz_visitors (id,name,phone,created_at,updated_at) VALUES (?,NULL,NULL,?,?)", [id, at, at]);
  await run(c, "INSERT INTO raiz_auth_sessions (token_hash,actor_type,actor_id,created_at,expires_at) VALUES (?,?,?,?,?)",
    [hash(token), type, id, at, new Date(Date.now() + lifetime * 1000).toISOString()]);
  return { token, csrfToken: hash(`raiz-csrf:${token}`) };
}
export function sessionCookie(response: NextResponse, request: NextRequest, type: Actor["type"], token: string, clear = false) {
  // The validated configured origin determines cookie policy, never forwarded Host.
  const origin = request.headers.get("origin");
  const secure = !!origin && trustedOrigins().includes(origin) && new URL(origin).protocol === "https:";
  response.cookies.set(cookieName(type), token, {
    httpOnly: true, path: "/", secure, sameSite: secure ? "none" : "lax",
    partitioned: secure, maxAge: clear ? 0 : lifetime,
  });
}
export async function loginAttempt(c: Connection, code: unknown) {
  if (!process.env.OWNER_ACCESS_CODE) throw new ApiError(503, "OWNER_UNAVAILABLE", "El acceso privado aún no está configurado.");
  if (typeof code !== "string" || code.length < 1 || code.length > 1024) invalid({ code: "Escribe tu código de acceso." });
  // A durable shared limiter cannot be bypassed by forging forwarded IP headers.
  const at = Date.now();
  const limit = await one(c, "SELECT attempts,window_start FROM raiz_login_limits WHERE scope='owner'");
  const fresh = !limit || at - Number(limit.window_start) >= 15 * 60 * 1000;
  const limited = !fresh && Number(limit.attempts) >= 10;
  if (limited) {
    // Admit at most one credential check per second across all instances after
    // the failed-attempt limit. Check this BEFORE comparing the code: a valid
    // credential must not bypass throttling, but failures must not lock out
    // the owner for the entire shared 15-minute window either.
    const admission = await one(c, "SELECT window_start FROM raiz_login_limits WHERE scope='owner:verification'");
    const retryAt = Number(admission?.window_start ?? 0) + 1000;
    if (retryAt > at) return { retryAt };
    await run(c, `INSERT INTO raiz_login_limits (scope,attempts,window_start) VALUES ('owner:verification',1,?)
      ON CONFLICT(scope) DO UPDATE SET window_start=excluded.window_start`, [at]);
  }
  const success = equal(code, process.env.OWNER_ACCESS_CODE);
  if (limited && !success) return ownerRateLimitError();
  await run(c, `INSERT INTO raiz_login_limits (scope,attempts,window_start) VALUES ('owner',?,?)
    ON CONFLICT(scope) DO UPDATE SET attempts=excluded.attempts,window_start=excluded.window_start`,
    [success ? 0 : fresh ? 1 : Number(limit.attempts) + 1, fresh || success ? at : Number(limit.window_start)]);
  return success ? null : new ApiError(401, "SESSION_REQUIRED", "No pudimos verificar el código de acceso.");
}
export function ownerRateLimitError() {
  return new ApiError(429, "RATE_LIMITED", "Se han realizado demasiados intentos. Espera 15 minutos antes de volver a entrar.");
}
