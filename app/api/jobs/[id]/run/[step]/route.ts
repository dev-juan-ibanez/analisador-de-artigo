import { getJob, hasActiveRun, isValidId, STEP_IDS, type StepId } from "@/lib/jobs";
import { runStep } from "@/lib/pipeline";

const AI_STEPS = STEP_IDS.filter((s) => s !== "conversao" && s !== "citacoes");

/**
 * Inicia UMA etapa em segundo plano. `?force=1` descarta o que já foi analisado (refazer do zero);
 * sem isso, trechos já analisados são reaproveitados (retomar).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[id]/run/[step]">) {
  const { id, step } = await ctx.params;
  if (!isValidId(id)) return Response.json({ error: "id inválido" }, { status: 400 });
  if (!(AI_STEPS as readonly string[]).includes(step)) {
    return Response.json({ error: "etapa inválida" }, { status: 400 });
  }
  const job = await getJob(id);
  if (!job) return Response.json({ error: "não encontrado" }, { status: 404 });
  if (job.steps.conversao.status !== "done") {
    return Response.json({ error: "A conversão não foi concluída." }, { status: 409 });
  }
  if (hasActiveRun(id)) {
    return Response.json({ error: "Já existe uma etapa em execução. Cancele-a ou aguarde." }, { status: 409 });
  }

  const force = new URL(request.url).searchParams.get("force") === "1";
  void runStep(id, step as StepId, { force });
  return Response.json({ started: step, force }, { status: 202 });
}
