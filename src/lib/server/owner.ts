import { type Connection, now, one, rows, run, uuid } from "./database";
import { conflict, exactFields, invalid, notFound, versionField } from "./errors";
import { audit, cancelReservation, checkVersion, activeFuture, promote, type Operation } from "./booking";
import { purchaseDTO, session } from "./records";
import type { Actor } from "./security";

export function validatedOwnerBody(operation: Operation, body: Record<string, unknown>): Record<string, unknown> {
  if (operation === "cancelSession" || operation === "collectPayment") {
    exactFields(body, ["expectedVersion"]);
    return { expectedVersion: versionField(body.expectedVersion) };
  }
  exactFields(body, ["classId", "instructorId", "roomId", "startsAt", "capacity", ...(operation === "editSession" ? ["expectedVersion"] : [])]);
  const fields: Record<string, string> = {};
  for (const key of ["classId", "instructorId", "roomId"]) {
    if (typeof body[key] !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(body[key] as string)) fields[key] = "Selecciona una opción disponible.";
  }
  const startsAt = body.startsAt;
  if (typeof startsAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(startsAt) ||
    !Number.isFinite(Date.parse(startsAt)) || new Date(startsAt).toISOString().replace(".000Z", "Z") !== startsAt.replace(".000Z", "Z")) {
    fields.startsAt = "Indica una fecha y hora válidas.";
  }
  if (typeof body.capacity !== "number" || !Number.isSafeInteger(body.capacity) || body.capacity < 1) fields.capacity = "La capacidad debe ser un número entero positivo.";
  if (Object.keys(fields).length) invalid(fields);
  return {
    classId: body.classId, instructorId: body.instructorId, roomId: body.roomId,
    startsAt: new Date(startsAt as string).toISOString(), capacity: body.capacity,
    ...(operation === "editSession" ? { expectedVersion: versionField(body.expectedVersion) } : {}),
  };
}
export async function ownerMutation(c: Connection, actor: Actor, operation: Operation, body: Record<string, unknown>, recordId?: string) {
  if (operation === "collectPayment") {
    const purchase = await one(c, "SELECT * FROM raiz_purchases WHERE id=?", [recordId!]);
    if (!purchase) notFound();
    checkVersion(Number(body.expectedVersion), purchaseDTO(purchase));
    if (purchase.payment_status !== "pending") conflict("VERSION_CONFLICT", "El cobro ya está registrado.", purchaseDTO(purchase));
    const write = await run(c, "UPDATE raiz_purchases SET payment_status='paid',paid_at=?,version=version+1 WHERE id=? AND version=? AND payment_status='pending'", [now(), recordId!, body.expectedVersion as number]);
    if (write.rowsAffected !== 1) conflict("VERSION_CONFLICT", "La compra cambió. Actualiza su estado.");
    await audit(c, actor, "collectPayment", "purchase", recordId!, { priceCOP: Number(purchase.price_cop) });
    return { entityType: "purchase", entityId: recordId!, version: Number(purchase.version) + 1, status: "paid" };
  }
  if (operation === "cancelSession") {
    const selected = await session(c, recordId!);
    activeFuture(selected);
    checkVersion(Number(body.expectedVersion), selected);
    const closed = await run(c, "UPDATE raiz_wait_entries SET status='closed',version=version+1 WHERE session_id=? AND status='waiting'", [selected.id]);
    await run(c, "UPDATE raiz_sessions SET status='cancelled',version=version+1 WHERE id=? AND version=?", [selected.id, selected.version]);
    const attendees = await rows(c, "SELECT * FROM raiz_reservations WHERE session_id=? AND status='confirmed' ORDER BY created_at,id", [selected.id]);
    for (const r of attendees) {
      await cancelReservation(c, r);
      await audit(c, actor, "cancelReservation", "reservation", String(r.id), { sessionId: selected.id, reason: "sessionCancelled" });
    }
    await audit(c, actor, operation, "session", selected.id, { refundedCredits: attendees.length, closedWaitCount: closed.rowsAffected });
    await promote(c);
    const updated = await session(c, selected.id);
    return { entityType: "session", entityId: selected.id, version: updated.version, status: updated.status, refundedCredits: attendees.length, closedWaitCount: closed.rowsAffected };
  }
  if (operation !== "createSession" && operation !== "editSession") throw new Error("Unknown owner operation");
  const existing = operation === "editSession" ? await session(c, recordId!) : null;
  if (existing) {
    activeFuture(existing);
    checkVersion(Number(body.expectedVersion), existing);
  }
  const classId = String(body.classId), roomId = String(body.roomId), instructorId = String(body.instructorId);
  const cl = await one(c, "SELECT * FROM raiz_classes WHERE id=?", [classId]);
  const room = await one(c, "SELECT * FROM raiz_rooms WHERE id=?", [roomId]);
  const instructor = await one(c, "SELECT * FROM raiz_instructors WHERE id=?", [instructorId]);
  const fields: Record<string, string> = {};
  if (!cl) fields.classId = "Selecciona una clase disponible.";
  if (!room) fields.roomId = "Selecciona una sala disponible.";
  if (!instructor) fields.instructorId = "Selecciona una instructora disponible.";
  if (Object.keys(fields).length) invalid(fields);
  const startsAt = String(body.startsAt);
  if (startsAt <= now()) conflict("STARTED", "Solo puedes programar sesiones futuras.", existing ?? undefined);
  const capacity = Number(body.capacity);
  if (capacity > Number(room!.capacity) || capacity < (existing?.occupied ?? 0)) {
    conflict("CAPACITY_INVALID", "La capacidad debe cubrir las reservas y no superar el máximo de la sala.", existing ?? undefined);
  }
  if (existing && existing.occupied > 0 &&
    (existing.classId !== classId || existing.roomId !== roomId || existing.instructorId !== instructorId || existing.startsAt !== startsAt)) {
    conflict("HAS_RESERVATIONS", "Esta sesión tiene reservas. Para cambiar su horario, clase, sala o instructora, cancélala y crea otra sesión.", existing);
  }
  const endsAt = new Date(Date.parse(startsAt) + Number(cl!.duration_minutes) * 60000).toISOString();
  const collision = await one(c, `SELECT id FROM raiz_sessions WHERE status='active' AND id<>?
    AND (room_id=? OR instructor_id=?) AND starts_at<? AND ends_at>? LIMIT 1`,
    [existing?.id ?? "", roomId, instructorId, endsAt, startsAt]);
  if (collision) conflict("OVERLAP", "La sala o la instructora ya tiene una sesión en ese horario.", existing ?? undefined);
  const id = existing?.id ?? uuid();
  if (existing) {
    const changed = await run(c, `UPDATE raiz_sessions SET class_id=?,instructor_id=?,room_id=?,starts_at=?,ends_at=?,capacity=?,version=version+1
      WHERE id=? AND version=?`, [classId, instructorId, roomId, startsAt, endsAt, capacity, id, existing.version]);
    if (changed.rowsAffected !== 1) conflict("VERSION_CONFLICT", "La sesión cambió. Actualiza su estado.");
  } else {
    await run(c, `INSERT INTO raiz_sessions (id,class_id,instructor_id,room_id,starts_at,ends_at,capacity,status,version,created_at)
      VALUES (?,?,?,?,?,?,?,'active',1,?)`, [id, classId, instructorId, roomId, startsAt, endsAt, capacity, now()]);
  }
  await audit(c, actor, operation, "session", id, { classId, instructorId, roomId, startsAt, endsAt, capacity });
  if (existing) await promote(c);
  const updated = await session(c, id);
  return { entityType: "session", entityId: id, version: updated.version, status: updated.status };
}
