import { NextRequest, NextResponse } from "next/server";
import { ensureDatabase, transaction, one, rows, run } from "./database";
import { ApiError, exactFields, idField, invalid, isUUID, notFound } from "./errors";
import { actor, createSession, loginAttempt, ownerRateLimitError, requireCsrf, requireOrigin, sessionCookie, type Actor } from "./security";
import { catalog, history, ownerDetail, purchaseDTO, result, schedule, session, validateQuery } from "./records";
import { idempotent, ownerOperations, validatedVisitorBody, visitorMutation, visitorOperations, type Operation } from "./booking";
import { ownerMutation, validatedOwnerBody } from "./owner";

const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Vary": "Cookie, Origin" };
function success(data: unknown) { return NextResponse.json({ ok: true, data }, { headers: responseHeaders }); }
function failure(error: unknown) {
  const e = error instanceof ApiError ? error : new ApiError(503, "UNAVAILABLE", "No pudimos completar la consulta. Conserva tu selección y vuelve a intentarlo.");
  return NextResponse.json({ error: { code: e.code, message: e.message, ...(e.fields ? { fields: e.fields } : {}), ...(e.current ? { current: e.current } : {}) } },
    { status: e.status, headers: { ...responseHeaders, ...(e.status === 429 ? { "Retry-After": "900" } : {}) } });
}
async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) invalid({ body: "Envía la solicitud en formato JSON." });
  const reader = request.body?.getReader();
  if (!reader) invalid({ body: "Faltan los datos de la solicitud." });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new ApiError(413, "TOO_LARGE", "La solicitud supera el tamaño permitido.");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { invalid({ body: "Los datos de la solicitud no son válidos." }); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") invalid({ body: "Completa los datos de la solicitud." });
  return parsed as Record<string, unknown>;
}
type Mutation = { operation: Operation; owner: boolean; id?: string };
function mutationFor(path: string): Mutation | undefined {
  if (path === "compras") return { operation: "purchase", owner: false };
  if (path === "reservas") return { operation: "reserve", owner: false };
  if (path === "espera") return { operation: "wait", owner: false };
  if (path === "duena/sesiones") return { operation: "createSession", owner: true };
  const routes: [RegExp, Operation, boolean][] = [
    [/^reservas\/([^/]+)\/cancelar$/, "cancelReservation", false],
    [/^espera\/([^/]+)\/salir$/, "leaveWait", false],
    [/^duena\/sesiones\/([^/]+)\/cancelar$/, "cancelSession", true],
    [/^duena\/sesiones\/([^/]+)$/, "editSession", true],
    [/^duena\/compras\/([^/]+)\/cobrar$/, "collectPayment", true],
  ];
  for (const [pattern, operation, owner] of routes) {
    const match = path.match(pattern);
    if (match) return { operation, owner, id: match[1] };
  }
}
async function get(request: NextRequest, path: string) {
  const query = request.nextUrl.searchParams;
  if (!["horario", "duena/horario", "operaciones"].includes(path)) validateQuery(query, []);
  // A write lock makes an absence check wait behind any admitted mutation.
  return transaction(async tx => {
    if (path === "catalogo") return catalog(tx);
    if (path === "horario") return schedule(tx, query);
    if (/^sesiones\/[^/]+$/.test(path)) return session(tx, idField(path.split("/")[1], "sessionId"));
    if (path === "sesion") {
      const a = (await actor(tx, request, "visitor"))!;
      const v = await one(tx, "SELECT name,phone FROM raiz_visitors WHERE id=?", [a.id]);
      return { established: true, csrfToken: a.csrfToken, profile: v?.name ? { name: String(v.name), phone: String(v.phone) } : null };
    }
    if (path === "duena/sesion") {
      const a = await actor(tx, request, "owner", false);
      return { configured: !!process.env.OWNER_ACCESS_CODE, authenticated: !!a, ...(a ? { csrfToken: a.csrfToken } : {}) };
    }
    if (path === "mis-clases") return history(tx, (await actor(tx, request, "visitor"))!.id);
    if (/^confirmaciones\/[^/]+$/.test(path)) {
      const a = (await actor(tx, request, "visitor"))!;
      const reference = path.split("/")[1];
      if (!isUUID(reference)) notFound();
      return result(tx, reference, a.id);
    }
    if (path === "operaciones") {
      validateQuery(query, ["key", "operation"]);
      const key = idField(query.get("key"), "key");
      const operation = query.get("operation");
      if (![...visitorOperations, ...ownerOperations].includes(operation as Operation)) invalid({ operation: "Indica la operación original que deseas consultar." });
      const type = (ownerOperations as readonly string[]).includes(operation!) ? "owner" : "visitor";
      const a = (await actor(tx, request, type))!;
      const op = await one(tx, "SELECT operation,status,result FROM raiz_operations WHERE actor_type=? AND actor_id=? AND key=?", [a.type, a.id, key]);
      if (!op) return { status: "absent" };
      if (op.operation !== operation) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Esta clave corresponde a otra solicitud.");
      return op.status === "confirmed" ? { status: "confirmed", result: JSON.parse(String(op.result)) } : { status: "pending" };
    }
    if (path.startsWith("duena/")) {
      await actor(tx, request, "owner");
      if (path === "duena/horario") return schedule(tx, query, true);
      if (path === "duena/compras") return { purchases: (await rows(tx, "SELECT * FROM raiz_purchases ORDER BY created_at DESC,id")).map(purchaseDTO) };
      if (/^duena\/sesiones\/[^/]+$/.test(path)) return ownerDetail(tx, idField(path.split("/")[2], "sessionId"));
    }
    notFound();
  }, path === "operaciones" ? "write" : "read");
}
async function post(request: NextRequest, path: string) {
  requireOrigin(request);
  validateQuery(request.nextUrl.searchParams, []);
  const body = await readBody(request);
  if (path === "sesion") {
    exactFields(body, []);
    const established = await transaction(async tx => {
      const existing = await actor(tx, request, "visitor", false);
      return existing ? { csrfToken: existing.csrfToken } : createSession(tx, "visitor");
    });
    const response = success({ established: true, csrfToken: established.csrfToken });
    if ("token" in established) sessionCookie(response, request, "visitor", established.token);
    return response;
  }
  if (path === "duena/login") {
    exactFields(body, ["code"]);
    // Commit attempt/admission state before responding. A single bounded wait
    // happens outside the write transaction so other studio operations can run.
    for (let admission = 0; admission < 2; admission++) {
      const login = await transaction(async tx => {
        const outcome = await loginAttempt(tx, body.code);
        if (outcome instanceof ApiError) return { error: outcome };
        if (outcome) return outcome;
        const previous = await actor(tx, request, "owner", false);
        if (previous) await run(tx, "DELETE FROM raiz_auth_sessions WHERE token_hash=? AND actor_type='owner'", [previous.tokenHash]);
        return { session: await createSession(tx, "owner", "owner") };
      });
      if ("retryAt" in login) {
        if (admission === 0) {
          await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(0, login.retryAt - Date.now()))));
          continue;
        }
        throw ownerRateLimitError();
      }
      if (login.error) throw login.error;
      const response = success({ authenticated: true, csrfToken: login.session!.csrfToken });
      sessionCookie(response, request, "owner", login.session!.token);
      return response;
    }
    throw ownerRateLimitError();
  }
  if (path === "duena/logout") {
    exactFields(body, []);
    await transaction(async tx => {
      const a = (await actor(tx, request, "owner"))!;
      requireCsrf(request, a);
      await run(tx, "DELETE FROM raiz_auth_sessions WHERE token_hash=? AND actor_type='owner'", [a.tokenHash]);
    });
    const response = success({ authenticated: false });
    sessionCookie(response, request, "owner", "", true);
    return response;
  }
  const mutation = mutationFor(path);
  if (!mutation) notFound();
  const data = await transaction(async tx => {
    const a: Actor = (await actor(tx, request, mutation.owner ? "owner" : "visitor"))!;
    requireCsrf(request, a);
    const key = request.headers.get("idempotency-key");
    if (!isUUID(key)) invalid({ idempotencyKey: "Conserva una clave válida para esta solicitud." });
    const recordId = mutation.id ? idField(mutation.id, "reference") : undefined;
    const validated = mutation.owner ? validatedOwnerBody(mutation.operation, body) : validatedVisitorBody(mutation.operation, body);
    return idempotent<unknown>(tx, a, key.toLowerCase(), mutation.operation, validated, recordId, async () => {
      if (mutation.owner) return ownerMutation(tx, a, mutation.operation, validated, recordId);
      return visitorMutation(tx, a, mutation.operation, validated, recordId);
    });
  });
  return success(data);
}
export async function handle(request: NextRequest, path: string[]) {
  try {
    if (request.method === "POST") requireOrigin(request);
    await ensureDatabase();
    const route = path.join("/");
    if (request.method === "GET" || request.method === "HEAD") return success(await get(request, route));
    if (request.method === "POST") return await post(request, route);
    return NextResponse.json({ error: { code: "METHOD_NOT_ALLOWED", message: "Este método no está permitido." } }, { status: 405, headers: { ...responseHeaders, Allow: "GET, POST" } });
  } catch (error) { return failure(error); }
}
