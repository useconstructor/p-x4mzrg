import { randomUUID } from "node:crypto";
import type { InStatement, InValue, Row, Transaction } from "@libsql/client";
import { db } from "@/lib/db";

export type Connection = Pick<Transaction, "execute">;
export const now = () => new Date().toISOString();
export const uuid = () => randomUUID();
export async function rows(c: Connection, sql: string, args: InValue[] = []): Promise<Row[]> {
  return (await c.execute({ sql, args })).rows;
}
export async function one(c: Connection, sql: string, args: InValue[] = []) {
  return (await rows(c, sql, args))[0];
}
export async function run(c: Connection, sql: string, args: InValue[] = []) {
  return c.execute({ sql, args });
}

// All application writes, including first use, share SQLite's write transaction.
// Retry only contention, never an ambiguous transport/commit failure.
export async function transaction<T>(fn: (tx: Transaction) => Promise<T>, mode: "write" | "read" = "write"): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let tx: Transaction | undefined;
    let committing = false;
    try {
      tx = await db.transaction(mode);
      const value = await fn(tx);
      committing = true;
      await tx.commit();
      return value;
    } catch (error) {
      if (tx && !tx.closed) await tx.rollback();
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (!committing && attempt < 3 && /SQLITE_BUSY|SQLITE_LOCKED/.test(code)) {
        await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
        continue;
      }
      throw error;
    } finally {
      tx?.close();
    }
  }
}

const schema = [
  `CREATE TABLE IF NOT EXISTS raiz_seed_markers (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS raiz_visitors (
    id TEXT PRIMARY KEY, name TEXT, phone TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS raiz_rooms (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(typeof(capacity)='integer' AND capacity>0))`,
  `CREATE TABLE IF NOT EXISTS raiz_instructors (id TEXT PRIMARY KEY, name TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS raiz_classes (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, discipline TEXT NOT NULL CHECK(discipline IN ('yoga','pilates')),
    level TEXT NOT NULL CHECK(level IN ('Inicial','Intermedio')), duration_minutes INTEGER NOT NULL CHECK(duration_minutes>0),
    price_cop INTEGER NOT NULL CHECK(typeof(price_cop)='integer' AND price_cop>0),
    diagram_key TEXT NOT NULL, presentation_version INTEGER NOT NULL CHECK(presentation_version>0),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>0))`,
  `CREATE TABLE IF NOT EXISTS raiz_packages (
    id TEXT PRIMARY KEY, credits INTEGER NOT NULL CHECK(credits IN (4,8,12)),
    price_cop INTEGER NOT NULL CHECK(typeof(price_cop)='integer' AND price_cop>0),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>0))`,
  `CREATE TABLE IF NOT EXISTS raiz_sessions (
    id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES raiz_classes(id),
    instructor_id TEXT NOT NULL REFERENCES raiz_instructors(id), room_id TEXT NOT NULL REFERENCES raiz_rooms(id),
    starts_at TEXT NOT NULL, ends_at TEXT NOT NULL CHECK(ends_at>starts_at),
    capacity INTEGER NOT NULL CHECK(typeof(capacity)='integer' AND capacity>0),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS raiz_purchases (
    id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL REFERENCES raiz_visitors(id),
    package_id TEXT NOT NULL REFERENCES raiz_packages(id), credits INTEGER NOT NULL CHECK(credits IN (4,8,12)),
    price_cop INTEGER NOT NULL CHECK(typeof(price_cop)='integer' AND price_cop>0),
    payment_status TEXT NOT NULL DEFAULT 'pending' CHECK(payment_status IN ('pending','paid')),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), snapshot TEXT NOT NULL, created_at TEXT NOT NULL, paid_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS raiz_reservations (
    id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL REFERENCES raiz_visitors(id),
    session_id TEXT NOT NULL REFERENCES raiz_sessions(id), status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled')),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), snapshot TEXT NOT NULL, created_at TEXT NOT NULL, cancelled_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS raiz_wait_entries (
    id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL REFERENCES raiz_visitors(id),
    session_id TEXT NOT NULL REFERENCES raiz_sessions(id), status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','promoted','left','closed')),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
    reservation_id TEXT REFERENCES raiz_reservations(id))`,
  `CREATE TABLE IF NOT EXISTS raiz_balance_movements (
    id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL REFERENCES raiz_visitors(id), delta INTEGER NOT NULL CHECK(typeof(delta)='integer' AND delta<>0),
    reason TEXT NOT NULL CHECK(reason IN ('purchase','reservation','refund','promotion')), source_id TEXT NOT NULL,
    created_at TEXT NOT NULL, UNIQUE(reason,source_id),
    CHECK((reason='purchase' AND delta IN (4,8,12)) OR (reason='refund' AND delta=1) OR (reason IN ('reservation','promotion') AND delta=-1)))`,
  `CREATE TABLE IF NOT EXISTS raiz_audit (
    id TEXT PRIMARY KEY, actor_type TEXT NOT NULL CHECK(actor_type IN ('visitor','owner','system')),
    actor_id TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    created_at TEXT NOT NULL, details TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS raiz_auth_sessions (
    token_hash TEXT PRIMARY KEY, actor_type TEXT NOT NULL CHECK(actor_type IN ('visitor','owner')),
    actor_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS raiz_operations (
    actor_type TEXT NOT NULL CHECK(actor_type IN ('visitor','owner')), actor_id TEXT NOT NULL, key TEXT NOT NULL,
    operation TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','confirmed')),
    result TEXT, created_at TEXT NOT NULL, PRIMARY KEY(actor_type,actor_id,key))`,
  `CREATE TABLE IF NOT EXISTS raiz_login_limits (scope TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_start INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS raiz_sessions_date ON raiz_sessions(starts_at,status)`,
  `CREATE INDEX IF NOT EXISTS raiz_sessions_room ON raiz_sessions(room_id,starts_at,ends_at)`,
  `CREATE INDEX IF NOT EXISTS raiz_sessions_instructor ON raiz_sessions(instructor_id,starts_at,ends_at)`,
  `CREATE INDEX IF NOT EXISTS raiz_reservations_visitor ON raiz_reservations(visitor_id,status)`,
  `CREATE INDEX IF NOT EXISTS raiz_reservations_session ON raiz_reservations(session_id,status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS raiz_reservation_active ON raiz_reservations(visitor_id,session_id) WHERE status='confirmed'`,
  `CREATE INDEX IF NOT EXISTS raiz_wait_visitor ON raiz_wait_entries(visitor_id,status)`,
  `CREATE INDEX IF NOT EXISTS raiz_wait_fifo ON raiz_wait_entries(session_id,status,created_at,id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS raiz_wait_active ON raiz_wait_entries(visitor_id,session_id) WHERE status='waiting'`,
  `CREATE INDEX IF NOT EXISTS raiz_purchases_visitor ON raiz_purchases(visitor_id,created_at)`,
  `CREATE INDEX IF NOT EXISTS raiz_movements_visitor ON raiz_balance_movements(visitor_id,created_at)`,
  `CREATE INDEX IF NOT EXISTS raiz_auth_actor ON raiz_auth_sessions(actor_type,actor_id)`,
  `CREATE INDEX IF NOT EXISTS raiz_audit_entity ON raiz_audit(entity_type,entity_id,created_at)`,
  `CREATE TRIGGER IF NOT EXISTS raiz_capacity_insert BEFORE INSERT ON raiz_sessions
    WHEN NEW.capacity>(SELECT capacity FROM raiz_rooms WHERE id=NEW.room_id)
    BEGIN SELECT RAISE(ABORT,'room capacity'); END`,
  `CREATE TRIGGER IF NOT EXISTS raiz_capacity_update BEFORE UPDATE ON raiz_sessions
    WHEN NEW.capacity>(SELECT capacity FROM raiz_rooms WHERE id=NEW.room_id)
      OR NEW.capacity<(SELECT COUNT(*) FROM raiz_reservations WHERE session_id=NEW.id AND status='confirmed')
    BEGIN SELECT RAISE(ABORT,'room capacity'); END`,
  `CREATE TRIGGER IF NOT EXISTS raiz_reservation_capacity BEFORE INSERT ON raiz_reservations WHEN NEW.status='confirmed'
    AND (SELECT COUNT(*) FROM raiz_reservations WHERE session_id=NEW.session_id AND status='confirmed') >=
        (SELECT capacity FROM raiz_sessions WHERE id=NEW.session_id)
    BEGIN SELECT RAISE(ABORT,'session full'); END`,
  `CREATE TRIGGER IF NOT EXISTS raiz_reservation_membership BEFORE INSERT ON raiz_reservations WHEN NEW.status='confirmed'
    AND EXISTS(SELECT 1 FROM raiz_wait_entries WHERE visitor_id=NEW.visitor_id AND session_id=NEW.session_id AND status='waiting')
    BEGIN SELECT RAISE(ABORT,'duplicate membership'); END`,
  `CREATE TRIGGER IF NOT EXISTS raiz_wait_membership BEFORE INSERT ON raiz_wait_entries WHEN NEW.status='waiting'
    AND EXISTS(SELECT 1 FROM raiz_reservations WHERE visitor_id=NEW.visitor_id AND session_id=NEW.session_id AND status='confirmed')
    BEGIN SELECT RAISE(ABORT,'duplicate membership'); END`,
  `CREATE TRIGGER IF NOT EXISTS raiz_nonnegative_balance BEFORE INSERT ON raiz_balance_movements
    WHEN NEW.delta<0 AND COALESCE((SELECT SUM(delta) FROM raiz_balance_movements WHERE visitor_id=NEW.visitor_id),0)+NEW.delta<0
    BEGIN SELECT RAISE(ABORT,'insufficient balance'); END`,
];

export function bogotaDate(instant = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}
export function monday(date = bogotaDate()): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

let ready: Promise<void> | undefined;
export function ensureDatabase(): Promise<void> {
  if (!ready) ready = transaction(async tx => {
    await tx.batch(schema);
    if (await one(tx, "SELECT id FROM raiz_seed_markers WHERE id=?", ["raiz-demo-v1"])) return;
    const createdAt = now();
    const seeds: InStatement[] = [];
    const classes = [
      ["yoga-suave", "Yoga suave", "yoga", "Inicial", 60, 30000],
      ["yoga-fluido", "Yoga fluido", "yoga", "Intermedio", 60, 35000],
      ["pilates-fundamentos", "Pilates fundamentos", "pilates", "Inicial", 50, 30000],
      ["pilates-control", "Pilates control", "pilates", "Intermedio", 50, 35000],
    ] as const;
    for (const [id, name, discipline, level, duration, price] of classes) {
      seeds.push({ sql: `INSERT INTO raiz_classes (id,name,discipline,level,duration_minutes,price_cop,diagram_key,presentation_version,version)
        VALUES (?,?,?,?,?,?,?,1,1) ON CONFLICT(id) DO NOTHING`, args: [id, name, discipline, level, duration, price, id] });
    }
    for (const [id, name, capacity] of [["semilla", "Semilla", 10], ["brote", "Brote", 8]] as const) {
      seeds.push({ sql: "INSERT INTO raiz_rooms (id,name,capacity) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING", args: [id, name, capacity] });
    }
    const instructors = [["ana", "Ana"], ["lucia", "Lucía"], ["sara", "Sara"], ["valentina", "Valentina"]] as const;
    for (const [id, name] of instructors) seeds.push({ sql: "INSERT INTO raiz_instructors (id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING", args: [id, name] });
    for (const [credits, price] of [[4, 110000], [8, 200000], [12, 270000]]) {
      seeds.push({ sql: "INSERT INTO raiz_packages (id,credits,price_cop,version) VALUES (?,?,?,1) ON CONFLICT(id) DO NOTHING", args: [`paquete-${credits}`, credits, price] });
    }
    const week = addDays(monday(), 7);
    for (let i = 0; i < classes.length; i++) {
      const startsAt = new Date(`${addDays(week, i)}T09:00:00-05:00`);
      seeds.push({ sql: `INSERT INTO raiz_sessions (id,class_id,instructor_id,room_id,starts_at,ends_at,capacity,status,version,created_at)
        VALUES (?,?,?,?,?,?,?,'active',1,?)`, args: [uuid(), classes[i][0], instructors[i][0], i % 2 ? "brote" : "semilla",
        startsAt.toISOString(), new Date(startsAt.getTime() + classes[i][4] * 60000).toISOString(), i % 2 ? 8 : 10, createdAt] });
    }
    seeds.push({ sql: "INSERT INTO raiz_seed_markers (id,created_at) VALUES (?,?)", args: ["raiz-demo-v1", createdAt] });
    await tx.batch(seeds);
  }).catch(error => { ready = undefined; throw error; });
  return ready;
}
