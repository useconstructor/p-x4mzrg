// Unrelated scaffold endpoints must not bypass the Raíz authorization model.
// Existing database records are deliberately retained.
export async function retired() {
  return Response.json({ error: { code: "NOT_FOUND", message: "Esta ruta no está disponible." } }, {
    status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
