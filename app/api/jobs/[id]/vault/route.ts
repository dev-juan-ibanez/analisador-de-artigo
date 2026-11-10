import { getJob, isValidId } from "@/lib/jobs";
import { VAULT_NAME, VAULT_ROOT, articleDir, mapNote, obsidianRegistered, syncVault } from "@/lib/vault";

/**
 * Garante o mapa do artigo no cofre do Obsidian. O Obsidian só abre por URL cofres já registrados;
 * por isso só devolvemos a URL quando o cofre estiver registrado (senão, a instrução de registro).
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/jobs/[id]/vault">) {
  const { id } = await ctx.params;
  const job = isValidId(id) ? await getJob(id) : null;
  if (!job) return Response.json({ error: "não encontrado" }, { status: 404 });
  await syncVault(id);
  const registered = await obsidianRegistered();
  const uri = registered
    ? `obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(mapNote(job))}`
    : null;
  return Response.json({ root: VAULT_ROOT, path: articleDir(job), registered, uri });
}
