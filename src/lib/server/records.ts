import type { Row } from "@libsql/client";
import { type Connection, addDays, monday, now, one, rows } from "./database";
import { invalid, notFound } from "./errors";

export function classDTO(r: Record<string, Row[string]>) {
  return {
    id: String(r.id), name: String(r.name), discipline: String(r.discipline), level: String(r.level),
    durationMinutes: Number(r.duration_minutes), priceCOP: Number(r.price_cop),
    diagramKey: String(r.diagram_key), presentationVersion: Number(r.presentation_version), version: Number(r.version),
  };
}
export function packageDTO(r: Row) {
  return { id: String(r.id), credits: Number(r.credits), priceCOP: Number(r.price_cop), version: Number(r.version) };
}
export async function catalog(c: Connection) {
  const classes = (await rows(c, "SELECT * FROM raiz_classes ORDER BY CASE id WHEN 'yoga-suave' THEN 1 WHEN 'yoga-fluido' THEN 2 WHEN 'pilates-fundamentos' THEN 3 ELSE 4 END")).map(classDTO);
  const rooms = (await rows(c, "SELECT * FROM raiz_rooms ORDER BY capacity DESC")).map(r => ({ id: String(r.id), name: String(r.name), capacity: Number(r.capacity) }));
  const instructors = (await rows(c, "SELECT * FROM raiz_instructors ORDER BY name")).map(r => ({ id: String(r.id), name: String(r.name) }));
  const packages = (await rows(c, "SELECT * FROM raiz_packages ORDER BY credits")).map(packageDTO);
  return { classes, rooms, instructors, packages, timeZone: "America/Bogota" };
}
const sessionSelect = `SELECT s.*,
  cl.name AS class_name,cl.discipline,cl.level,cl.duration_minutes,cl.price_cop,
  cl.diagram_key,cl.presentation_version,cl.version AS class_version,
  i.name AS instructor_name,rm.name AS room_name,rm.capacity AS room_capacity,
  (SELECT COUNT(*) FROM raiz_reservations r WHERE r.session_id=s.id AND r.status='confirmed') AS occupied,
  (SELECT COUNT(*) FROM raiz_wait_entries w WHERE w.session_id=s.id AND w.status='waiting') AS wait_count
  FROM raiz_sessions s JOIN raiz_classes cl ON cl.id=s.class_id
  JOIN raiz_instructors i ON i.id=s.instructor_id JOIN raiz_rooms rm ON rm.id=s.room_id`;
export function sessionDTO(r: Row) {
  return {
    id: String(r.id), classId: String(r.class_id), instructorId: String(r.instructor_id), roomId: String(r.room_id),
    startsAt: String(r.starts_at), endsAt: String(r.ends_at), capacity: Number(r.capacity),
    status: String(r.status) as "active" | "cancelled", version: Number(r.version),
    occupied: Number(r.occupied), available: Number(r.capacity) - Number(r.occupied), waitCount: Number(r.wait_count),
    started: String(r.starts_at) <= now(),
    class: classDTO({
      id: r.class_id, name: r.class_name, version: r.class_version,
      discipline: r.discipline, level: r.level, duration_minutes: r.duration_minutes,
      price_cop: r.price_cop, diagram_key: r.diagram_key, presentation_version: r.presentation_version,
    }),
    instructor: { id: String(r.instructor_id), name: String(r.instructor_name) },
    room: { id: String(r.room_id), name: String(r.room_name), capacity: Number(r.room_capacity) },
  };
}
export type SessionDTO = Awaited<ReturnType<typeof sessionDTO>>;
export async function session(c: Connection, id: string) {
  const r = await one(c, `${sessionSelect} WHERE s.id=?`, [id]);
  if (!r) notFound();
  return sessionDTO(r);
}
export function validateQuery(query: URLSearchParams, allowed: string[]) {
  const fields: Record<string, string> = Object.create(null);
  for (const key of query.keys()) {
    if (!allowed.includes(key)) fields[key] = "Este filtro no está permitido.";
    else if (query.getAll(key).length !== 1) fields[key] = "Usa un solo valor para este filtro.";
  }
  if (Object.keys(fields).length) invalid(fields);
}
export async function schedule(c: Connection, query: URLSearchParams, owner = false) {
  validateQuery(query, owner ? ["semana"] : ["semana", "clase", "disciplina", "nivel", "instructora"]);
  const supplied = query.get("semana");
  if (supplied !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(supplied) ||
    !Number.isFinite(Date.parse(`${supplied}T12:00:00Z`)) ||
    new Date(`${supplied}T12:00:00Z`).toISOString().slice(0, 10) !== supplied || monday(supplied) !== supplied)) {
    invalid({ semana: "Elige el lunes de una semana válida." });
  }
  const weekStart = supplied ?? monday();
  const params: (string | number)[] = [new Date(`${weekStart}T00:00:00-05:00`).toISOString(), new Date(`${addDays(weekStart, 7)}T00:00:00-05:00`).toISOString()];
  let filter = "s.starts_at>=? AND s.starts_at<?";
  const cl = query.get("clase");
  const instructor = query.get("instructora");
  const discipline = query.get("disciplina");
  const level = query.get("nivel");
  if (cl !== null) {
    if (!await one(c, "SELECT id FROM raiz_classes WHERE id=?", [cl])) invalid({ clase: "Selecciona una clase disponible." });
    filter += " AND s.class_id=?"; params.push(cl);
  }
  if (instructor !== null) {
    if (!await one(c, "SELECT id FROM raiz_instructors WHERE id=?", [instructor])) invalid({ instructora: "Selecciona una instructora disponible." });
    filter += " AND s.instructor_id=?"; params.push(instructor);
  }
  if (discipline !== null) {
    if (!["yoga", "pilates"].includes(discipline)) invalid({ disciplina: "Selecciona yoga o pilates." });
    filter += " AND s.class_id IN (SELECT id FROM raiz_classes WHERE discipline=?)"; params.push(discipline);
  }
  if (level !== null) {
    if (!["Inicial", "Intermedio"].includes(level)) invalid({ nivel: "Selecciona un nivel disponible." });
    filter += " AND s.class_id IN (SELECT id FROM raiz_classes WHERE level=?)"; params.push(level);
  }
  const records = await rows(c, `${sessionSelect} WHERE ${filter} ORDER BY s.starts_at,s.id`, params);
  const sessions = records.map(sessionDTO);
  return { weekStart, timeZone: "America/Bogota", serverNow: now(), sessions };
}
export async function totals(c: Connection, visitorId: string) {
  const values = await one(c, `SELECT
    (SELECT COALESCE(SUM(delta),0) FROM raiz_balance_movements WHERE visitor_id=?) AS balance,
    (SELECT COALESCE(SUM(price_cop),0) FROM raiz_purchases WHERE visitor_id=? AND payment_status='pending') AS debt`,
    [visitorId, visitorId]);
  return { balance: Number(values?.balance ?? 0), debtCOP: Number(values?.debt ?? 0) };
}
export type Snapshot = {
  kind: "purchase" | "reservation" | "wait"; name: string; phone: string; createdAt: string;
  package?: { id: string; credits: number; priceCOP: number };
  session?: {
    id: string; classId: string; className: string; discipline: string; level: string;
    durationMinutes: number; priceCOP: number; diagramKey: string; presentationVersion: number;
    instructorId: string; instructorName: string; roomId: string; roomName: string; startsAt: string; endsAt: string;
  };
};
export function sessionSnapshot(s: SessionDTO): NonNullable<Snapshot["session"]> {
  return {
    id: s.id, classId: s.classId, className: s.class.name, discipline: s.class.discipline, level: s.class.level,
    durationMinutes: s.class.durationMinutes, priceCOP: s.class.priceCOP, diagramKey: s.class.diagramKey,
    presentationVersion: s.class.presentationVersion, instructorId: s.instructorId, instructorName: s.instructor.name,
    roomId: s.roomId, roomName: s.room.name, startsAt: s.startsAt, endsAt: s.endsAt,
  };
}
export function purchaseDTO(r: Row) {
  return { id: String(r.id), packageId: String(r.package_id), credits: Number(r.credits), priceCOP: Number(r.price_cop),
    paymentStatus: String(r.payment_status), version: Number(r.version), snapshot: JSON.parse(String(r.snapshot)) as Snapshot,
    createdAt: String(r.created_at), paidAt: r.paid_at ? String(r.paid_at) : null };
}
export function reservationDTO(r: Row) {
  return { id: String(r.id), sessionId: String(r.session_id), status: String(r.status), version: Number(r.version),
    snapshot: JSON.parse(String(r.snapshot)) as Snapshot, createdAt: String(r.created_at), cancelledAt: r.cancelled_at ? String(r.cancelled_at) : null };
}
export function waitDTO(r: Row) {
  return { id: String(r.id), sessionId: String(r.session_id), status: String(r.status), version: Number(r.version),
    snapshot: JSON.parse(String(r.snapshot)) as Snapshot, createdAt: String(r.created_at), reservationId: r.reservation_id ? String(r.reservation_id) : null };
}
export async function result(c: Connection, reference: string, visitorId: string) {
  const p = await one(c, "SELECT * FROM raiz_purchases WHERE id=? AND visitor_id=?", [reference, visitorId]);
  const r = p ? undefined : await one(c, "SELECT * FROM raiz_reservations WHERE id=? AND visitor_id=?", [reference, visitorId]);
  const w = p || r ? undefined : await one(c, "SELECT * FROM raiz_wait_entries WHERE id=? AND visitor_id=?", [reference, visitorId]);
  const record = p || r || w;
  if (!record) notFound();
  return {
    reference, kind: p ? "purchase" : r ? "reservation" : "wait",
    originalOutcome: p ? "credited" : r ? "confirmed" : "waiting",
    snapshot: JSON.parse(String(record.snapshot)) as Snapshot,
    currentStatus: String(p ? record.payment_status : record.status), version: Number(record.version),
    ...(w?.reservation_id ? { reservationId: String(w.reservation_id) } : {}),
    ...await totals(c, visitorId),
  };
}
export async function history(c: Connection, visitorId: string) {
  const reservations = (await rows(c, `SELECT * FROM raiz_reservations WHERE visitor_id=? ORDER BY created_at DESC,id`, [visitorId])).map(reservationDTO);
  const waits = (await rows(c, `SELECT * FROM raiz_wait_entries WHERE visitor_id=? ORDER BY created_at DESC,id`, [visitorId])).map(waitDTO);
  const purchases = (await rows(c, `SELECT * FROM raiz_purchases WHERE visitor_id=? ORDER BY created_at DESC,id`, [visitorId])).map(purchaseDTO);
  return { ...await totals(c, visitorId), serverNow: now(), reservations, waits, purchases };
}
export async function ownerDetail(c: Connection, id: string) {
  const selected = await session(c, id);
  const map = (r: Row) => {
    const snap = JSON.parse(String(r.snapshot)) as Snapshot;
    return { id: String(r.id), name: snap.name, phone: snap.phone, status: String(r.status), createdAt: String(r.created_at), version: Number(r.version) };
  };
  const attendees = (await rows(c, "SELECT * FROM raiz_reservations WHERE session_id=? AND status='confirmed' ORDER BY created_at,id", [id])).map(map);
  const waits = (await rows(c, "SELECT * FROM raiz_wait_entries WHERE session_id=? AND status='waiting' ORDER BY created_at,id", [id])).map(map);
  return { session: selected, attendees, waits };
}
