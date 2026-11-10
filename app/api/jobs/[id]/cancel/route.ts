import { cancelRuns, getJob, isValidId } from "@/lib/jobs";

/** Cancela a etapa em execução (encerra os processos de IA). O que já foi analisado fica guardado. */
export async function POST(_req: Request, ctx: RouteContext<"/api/jobs/[id]/cancel">) {
  const { id } = await ctx.params;
  if (!isValidId(id)) return Response.json({ error: "id inválido" }, { status: 400 });
  const n = cancelRuns(id);
  // Dá um instante para o pipeline gravar o status "cancelled".
  await new Promise((r) => setTimeout(r, 300));
  return Response.json({ cancelled: n, job: await getJob(id) });
}
