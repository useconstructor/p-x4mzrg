export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
    public current?: unknown,
  ) { super(message); }
}
export function invalid(fields: Record<string, string>): never {
  throw new ApiError(400, "VALIDATION", "Revisa los campos indicados.", fields);
}
export function notFound(): never {
  throw new ApiError(404, "NOT_FOUND", "No encontramos esta referencia disponible para tu sesión.");
}
export function conflict(code: string, message: string, current?: unknown): never {
  throw new ApiError(409, code, message, undefined, current);
}
export const isUUID = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export function idField(value: unknown, field: string): string {
  if (!isUUID(value)) invalid({ [field]: "Selecciona una referencia válida." });
  return value.toLowerCase();
}
export function versionField(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid({ expectedVersion: "Revisa la versión vigente antes de confirmar." });
  return value;
}
export function exactFields(body: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(body).filter(key => !allowed.includes(key));
  if (extra.length) invalid(Object.fromEntries(extra.map(key => [key, "Este campo no está permitido."])));
}
export function profileFields(body: Record<string, unknown>) {
  const fields: Record<string, string> = {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const rawPhone = typeof body.phone === "string" ? body.phone.trim() : "";
  const phone = rawPhone.replace(/[ +()-]/g, "");
  if ([...name].length < 2 || [...name].length > 100) fields.name = "Escribe un nombre de entre 2 y 100 caracteres.";
  if (!/^[0-9 +()-]+$/.test(rawPhone) || !/^\d{7,15}$/.test(phone)) fields.phone = "Escribe un teléfono de entre 7 y 15 dígitos.";
  if (Object.keys(fields).length) invalid(fields);
  return { name, phone };
}
