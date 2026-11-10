# Analisador de Artigo Científico

App Next.js 16 (App Router) que usa o Claude Code local (`claude -p --agent ...`) como motor de análise. Leia `README.md`.
Next.js aqui é a v16: consulte `node_modules/next/dist/docs/` antes de usar APIs novas (ver AGENTS.md).

- Etapas SEM IA: `lib/convert.ts` (pandoc / pdftotext / LibreOffice) e `lib/citations.ts`.
- Etapas COM IA: agentes em `.claude/agents/*.md`; rubricas em `knowledge/*.md` (embutidas na mensagem por `lib/agents.ts`).
- Uma etapa por vez, iniciada pelo usuário (botão Próximo). Cancelar/retomar: `lib/pipeline.ts` + cache em `data/jobs/<id>/cache/`.
- Numeração de parágrafos (¶) por seção: `lib/numbering.ts` é a única fonte; agentes e relatório citam seção + ¶.
- Para melhorar um agente: edite a rubrica em `knowledge/` e/ou o agente; não há fine-tuning.
- Teste sem gastar tokens: crie `data/MOCK`. Dados de uso ficam em `data/` (ignorado pelo git).
- Artigos de alunos contêm dados pessoais: nunca versionar (`.gitignore` cobre `/*.docx` etc.).
