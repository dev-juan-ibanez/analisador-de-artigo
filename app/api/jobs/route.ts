import fs from "node:fs/promises";
import path from "node:path";
import { createJob, jobDir, jobFile, listJobs, updateStep } from "@/lib/jobs";
import { convertToMarkdown, SUPPORTED_EXTENSIONS } from "@/lib/convert";
import { analyzeCitations, citationReportToMarkdown } from "@/lib/citations";
import { numberedMarkdown } from "@/lib/numbering";

export const maxDuration = 300;

export async function GET() {
  return Response.json(await listJobs());
}

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Envie um arquivo no campo 'file'." }, { status: 400 });
  }
  const ext = path.extname(file.name).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return Response.json(
      { error: `Formato não suportado (${ext || "sem extensão"}). Use: ${SUPPORTED_EXTENSIONS.join(", ")}` },
      { status: 400 },
    );
  }

  const job = await createJob(file.name);
  const dir = jobDir(job.id);
  const original = path.join(dir, `original${ext}`);
  await fs.writeFile(original, Buffer.from(await file.arrayBuffer()));

  await updateStep(job.id, "conversao", { status: "running", startedAt: new Date().toISOString() });
  try {
    const { markdown, notes } = await convertToMarkdown(original, dir);
    await fs.writeFile(jobFile(job.id, "article.md"), markdown);
    await fs.writeFile(jobFile(job.id, "numerado.md"), numberedMarkdown(markdown));
    await updateStep(job.id, "conversao", {
      status: "done",
      finishedAt: new Date().toISOString(),
      progress: notes.join(" ") || undefined,
    });

    await updateStep(job.id, "citacoes", { status: "running" });
    const report = analyzeCitations(markdown);
    await fs.writeFile(jobFile(job.id, "citacoes.json"), JSON.stringify(report, null, 2));
    await fs.writeFile(jobFile(job.id, "citacoes.md"), citationReportToMarkdown(report));
    await updateStep(job.id, "citacoes", { status: "done", finishedAt: new Date().toISOString() });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await updateStep(job.id, "conversao", { status: "error", error: message });
    return Response.json({ id: job.id, error: message }, { status: 422 });
  }
  return Response.json({ id: job.id });
}
