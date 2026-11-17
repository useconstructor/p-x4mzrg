import type { Row } from "@libsql/client";
import { type Connection, now, one, rows, run, uuid } from "./database";
import { conflict, exactFields, idField, invalid, notFound, profileFields, versionField } from "./errors";
import { packageDTO, result, session, sessionSnapshot, totals, type SessionDTO, type Snapshot } from "./records";
import { type Actor, hash } from "./security";

export const visitorOperations = ["purchase", "reserve", "wait", "cancelReservation", "leaveWait"] as const;
export const ownerOperations = ["createSession", "editSession", "cancelSession", "collectPayment"] as const;
export type Operation = typeof visitorOperations[number] | typeof ownerOperations[number];

export async function audit(c: Connection, actor: Pick<Actor, "type" | "id"> | { type: "system"; id: string }, action: string, entityType: string, entityId: string, details: Record<string, unknown> = {}) {
  await run(c, "INSERT INTO raiz_audit (id,actor_type,actor_id,action,entity_type,entity_id,created_at,details) VALUES (?,?,?,?,?,?,?,?)",
    [uuid(), actor.type, actor.id, action, entityType, entityId, now(), JSON.stringify(details)]);
}
export async function movement(c: Connection, visitorId: string, delta: number, reason: "purchase" | "reservation" | "refund" | "promotion", sourceId: string) {
  await run(c, "INSERT INTO raiz_balance_movements (id,visitor_id,delta,reason,source_id,created_at) VALUES (?,?,?,?,?,?)",
    [uuid(), visitorId, delta, reason, sourceId, now()]);
}
export async function bump(c: Connection, sessionId: string) {
  await run(c, "UPDATE raiz_sessions SET version=version+1 WHERE id=?", [sessionId]);
}
export function checkVersion(expected: number, current: { version: number }, price = false) {
  if (expected !== current.version) conflict(price ? "PRICE_CHANGED" : "VERSION_CONFLICT",
    price ? "El paquete ha cambiado. Revisa el precio vigente antes de comprar." : "La información ha cambiado. Revisa el estado vigente antes de confirmar.", current);
}
export function activeFuture(s: SessionDTO) {
  if (s.status !== "active") conflict("CANCELLED", "Esta sesión está cancelada.", s);
  if (s.startsAt <= now()) conflict("STARTED", "Esta sesión ya comenzó. Elige una sesión futura.", s);
}
async function overlap(c: Connection, visitorId: string, s: SessionDTO) {
  return one(c, `SELECT r.id FROM raiz_reservations r JOIN raiz_sessions s ON s.id=r.session_id
    WHERE r.visitor_id=? AND r.status='confirmed' AND s.status='active' AND s.starts_at<? AND s.ends_at>? LIMIT 1`,
    [visitorId, s.endsAt, s.startsAt]);
}
async function member(c: Connection, visitorId: string, sessionId: string) {
  return (await one(c, "SELECT id FROM raiz_reservations WHERE visitor_id=? AND session_id=? AND status='confirmed'", [visitorId, sessionId])) ||
    (await one(c, "SELECT id FROM raiz_wait_entries WHERE visitor_id=? AND session_id=? AND status='waiting'", [visitorId, sessionId]));
}
async function profile(c: Connection, visitorId: string, values: { name: string; phone: string }) {
  await run(c, "UPDATE raiz_visitors SET name=?,phone=?,updated_at=? WHERE id=?", [values.name, values.phone, now(), visitorId]);
}
async function reserveRecord(c: Connection, visitorId: string, selected: SessionDTO, identity: { name: string; phone: string }, reason: "reservation" | "promotion") {
  const id = uuid();
  const createdAt = now();
  const snapshot: Snapshot = { kind: "reservation", ...identity, session: sessionSnapshot(selected), createdAt };
  await run(c, "INSERT INTO raiz_reservations (id,visitor_id,session_id,status,version,snapshot,created_at) VALUES (?,?,?,'confirmed',1,?,?)",
    [id, visitorId, selected.id, JSON.stringify(snapshot), createdAt]);
  await movement(c, visitorId, -1, reason, id);
  await bump(c, selected.id);
  return id;
}

// Deterministic reconsideration across all future sessions. Eligibility is read
// again after every promotion so one credit cannot promote overlapping entries.
export async function promote(c: Connection) {
  const pendingSessions = await rows(c, `SELECT DISTINCT s.id,s.starts_at FROM raiz_sessions s
    JOIN raiz_wait_entries w ON w.session_id=s.id WHERE s.status='active' AND s.starts_at>? AND w.status='waiting'
    ORDER BY s.starts_at,s.id`, [now()]);
  for (const item of pendingSessions) {
    let selected = await session(c, String(item.id));
    if (selected.available <= 0) continue;
    const queue = await rows(c, "SELECT * FROM raiz_wait_entries WHERE session_id=? AND status='waiting' ORDER BY created_at,id", [selected.id]);
    for (const entry of queue) {
      if (selected.available <= 0 || selected.startsAt <= now()) break;
      const visitorId = String(entry.visitor_id);
      if ((await totals(c, visitorId)).balance < 1 || await overlap(c, visitorId, selected)) continue;
      if (await one(c, "SELECT id FROM raiz_reservations WHERE visitor_id=? AND session_id=? AND status='confirmed'", [visitorId, selected.id])) continue;
      const snap = JSON.parse(String(entry.snapshot)) as Snapshot;
      await run(c, "UPDATE raiz_wait_entries SET status='promoted',version=version+1 WHERE id=? AND status='waiting'", [entry.id]);
      const reservationId = await reserveRecord(c, visitorId, selected, { name: snap.name, phone: snap.phone }, "promotion");
      await run(c, "UPDATE raiz_wait_entries SET reservation_id=? WHERE id=?", [reservationId, entry.id]);
      await audit(c, { type: "system", id: "waitlist" }, "promote", "wait", String(entry.id), { reservationId, sessionId: selected.id });
      await audit(c, { type: "system", id: "waitlist" }, "reserve", "reservation", reservationId, { waitId: String(entry.id) });
      selected = await session(c, selected.id);
    }
  }
}

export function validatedVisitorBody(operation: Operation, body: Record<string, unknown>) {
  if (operation === "purchase") {
    exactFields(body, ["packageId", "expectedVersion", "name", "phone"]);
    const identity = profileFields(body);
    if (typeof body.packageId !== "string" || !/^paquete-(4|8|12)$/.test(body.packageId)) invalid({ packageId: "Selecciona un paquete de 4, 8 o 12 clases." });
    return { packageId: body.packageId, expectedVersion: versionField(body.expectedVersion), ...identity };
  }
  if (operation === "reserve" || operation === "wait") {
    exactFields(body, ["sessionId", "expectedVersion", "name", "phone"]);
    return { sessionId: idField(body.sessionId, "sessionId"), expectedVersion: versionField(body.expectedVersion), ...profileFields(body) };
  }
  exactFields(body, ["expectedVersion"]);
  return { expectedVersion: versionField(body.expectedVersion) };
}

export async function visitorMutation(c: Connection, actor: Actor, operation: Operation, body: Record<string, unknown>, recordId?: string) {
  if (operation === "purchase") {
    const p = await one(c, "SELECT * FROM raiz_packages WHERE id=?", [String(body.packageId)]);
    if (!p) invalid({ packageId: "Selecciona un paquete disponible." });
    const selected = packageDTO(p);
    checkVersion(Number(body.expectedVersion), selected, true);
    const id = uuid();
    const createdAt = now();
    const identity = { name: String(body.name), phone: String(body.phone) };
    const snapshot: Snapshot = { kind: "purchase", ...identity, package: { id: selected.id, credits: selected.credits, priceCOP: selected.priceCOP }, createdAt };
    await run(c, `INSERT INTO raiz_purchases (id,visitor_id,package_id,credits,price_cop,payment_status,version,snapshot,created_at)
      VALUES (?,?,?,?,?,'pending',1,?,?)`, [id, actor.id, selected.id, selected.credits, selected.priceCOP, JSON.stringify(snapshot), createdAt]);
    await movement(c, actor.id, selected.credits, "purchase", id);
    await profile(c, actor.id, identity);
    await audit(c, actor, "purchase", "purchase", id, { credits: selected.credits, priceCOP: selected.priceCOP });
    await promote(c);
    return result(c, id, actor.id);
  }
  if (operation === "reserve" || operation === "wait") {
    const selected = await session(c, String(body.sessionId));
    activeFuture(selected);
    checkVersion(Number(body.expectedVersion), selected);
    if (await member(c, actor.id, selected.id)) conflict("DUPLICATE", "Ya tienes una reserva o una inscripción en espera para esta sesión.", selected);
    const identity = { name: String(body.name), phone: String(body.phone) };
    let id: string;
    if (operation === "reserve") {
      if (selected.available < 1) conflict("FULL", "Esta sesión está llena. Puedes elegir entrar en espera.", selected);
      if ((await totals(c, actor.id)).balance < 1) conflict("INSUFFICIENT_BALANCE", "Necesitas una clase de saldo para reservar. Puedes comprar un paquete y volver a esta sesión.", selected);
      if (await overlap(c, actor.id, selected)) conflict("OVERLAP", "Ya tienes una reserva que coincide con este horario.", selected);
      id = await reserveRecord(c, actor.id, selected, identity, "reservation");
    } else {
      if (selected.available > 0) conflict("NOT_FULL", "Hay cupos disponibles. Revisa la sesión para reservar.", selected);
      id = uuid();
      const createdAt = now();
      const snapshot: Snapshot = { kind: "wait", ...identity, session: sessionSnapshot(selected), createdAt };
      await run(c, "INSERT INTO raiz_wait_entries (id,visitor_id,session_id,status,version,snapshot,created_at) VALUES (?,?,?,'waiting',1,?,?)",
        [id, actor.id, selected.id, JSON.stringify(snapshot), createdAt]);
      await bump(c, selected.id);
    }
    await profile(c, actor.id, identity);
    await audit(c, actor, operation, operation === "reserve" ? "reservation" : "wait", id, { sessionId: selected.id });
    return result(c, id, actor.id);
  }
  if (operation === "cancelReservation") {
    const r = await one(c, "SELECT * FROM raiz_reservations WHERE id=? AND visitor_id=?", [recordId!, actor.id]);
    if (!r) notFound();
    checkVersion(Number(body.expectedVersion), await result(c, recordId!, actor.id));
    if (r.status !== "confirmed") conflict("CANCELLED", "Esta reserva ya está cancelada.", await result(c, recordId!, actor.id));
    const selected = await session(c, String(r.session_id));
    activeFuture(selected);
    await cancelReservation(c, r);
    await audit(c, actor, operation, "reservation", String(r.id));
    await promote(c);
    return result(c, String(r.id), actor.id);
  }
  if (operation === "leaveWait") {
    const w = await one(c, "SELECT * FROM raiz_wait_entries WHERE id=? AND visitor_id=?", [recordId!, actor.id]);
    if (!w) notFound();
    checkVersion(Number(body.expectedVersion), await result(c, recordId!, actor.id));
    if (w.status !== "waiting") conflict("VERSION_CONFLICT", "La inscripción ya cambió de estado. Actualiza Mis clases.", await result(c, recordId!, actor.id));
    activeFuture(await session(c, String(w.session_id)));
    await run(c, "UPDATE raiz_wait_entries SET status='left',version=version+1 WHERE id=? AND version=?", [w.id, w.version]);
    await bump(c, String(w.session_id));
    await audit(c, actor, operation, "wait", String(w.id));
    return result(c, String(w.id), actor.id);
  }
  throw new Error("Unknown visitor operation");
}
export async function cancelReservation(c: Connection, r: Row) {
  const updated = await run(c, "UPDATE raiz_reservations SET status='cancelled',version=version+1,cancelled_at=? WHERE id=? AND status='confirmed' AND version=?", [now(), r.id, r.version]);
  if (updated.rowsAffected !== 1) conflict("VERSION_CONFLICT", "La reserva cambió. Actualiza su estado.");
  await movement(c, String(r.visitor_id), 1, "refund", String(r.id));
  await bump(c, String(r.session_id));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function idempotent<T>(c: Connection, actor: Actor, key: string, operation: Operation, body: Record<string, unknown>, recordId: string | undefined, work: () => Promise<T>): Promise<T> {
  const payloadHash = hash(canonical({ body, recordId: recordId ?? null }));
  const existing = await one(c, "SELECT * FROM raiz_operations WHERE actor_type=? AND actor_id=? AND key=?", [actor.type, actor.id, key]);
  if (existing) {
    if (existing.operation !== operation || existing.payload_hash !== payloadHash) conflict("IDEMPOTENCY_CONFLICT", "Esta solicitud pertenece a otra intención. Recupera la original o inicia una solicitud nueva.");
    if (existing.status !== "confirmed" || !existing.result) conflict("PENDING", "La solicitud sigue pendiente. Consulta su estado antes de continuar.");
    return JSON.parse(String(existing.result)) as T;
  }
  await run(c, `INSERT INTO raiz_operations (actor_type,actor_id,key,operation,payload_hash,status,result,created_at) VALUES (?,?,?,?,?,'pending',NULL,?)`,
    [actor.type, actor.id, key, operation, payloadHash, now()]);
  const value = await work();
  await run(c, "UPDATE raiz_operations SET status='confirmed',result=? WHERE actor_type=? AND actor_id=? AND key=?", [JSON.stringify(value), actor.type, actor.id, key]);
  return value;
}
