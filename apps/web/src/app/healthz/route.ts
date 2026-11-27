/** Liveness endpoint for the container healthcheck. Never cached. */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
