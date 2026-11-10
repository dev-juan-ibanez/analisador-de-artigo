# Rubrica: citações e referências

A **extração** (listar citações e referências, cruzar, gerar links) é feita por código determinístico, sem IA.
A **verificação de existência é manual** (feita pelo usuário). Esta rubrica explica o que checar.

## O que o usuário deve checar em cada referência
1. A obra existe? Buscar pelo título entre aspas no Google Scholar / Crossref / OpenAlex / catálogo da biblioteca.
2. **DOI**: abrir `https://doi.org/<doi>` — e conferir que o título/autores/ano da página **batem** com a referência.
   (Referência alucinada pode ter DOI real que aponta para OUTRO artigo; DOI que resolve não basta.)
3. Autores, ano, periódico, volume, páginas conferem?
4. Obras sem DOI (livros, teses, relatórios, normas, preprints) → conferir em catálogo/repositório da instituição.
5. A obra diz o que o texto afirma? (citação "decorativa" ou distorcida).
6. A fonte é primária, atual (últimos 5–10 anos, salvo clássicos), e de qualidade (revisada por pares)?

## Padrões de problema no cruzamento texto ↔ lista
- **Citada no texto e ausente da lista** → erro formal ou referência inventada.
- **Na lista e nunca citada** → remover ou citar.
- **Ano divergente** entre texto e lista; sufixos a/b ausentes quando mesmo autor/ano.
- **Autoria divergente** (ex.: "Silva et al." no texto vs. dois autores na lista).
- **Citação indireta sem página** (aceitável); **citação direta sem página** (erro em ABNT/APA).
- **Apud excessivo** (fonte secundária no lugar da primária).
- **Autocitação desproporcional**; **concentração** em poucas fontes.
- Formato inconsistente entre referências (mistura ABNT/APA/Vancouver).
- Ordem: ABNT/APA → alfabética; Vancouver/IEEE → ordem de aparição.

## Sinais de referência suspeita (para o usuário priorizar a checagem)
- Sem DOI **e** sem URL **e** periódico não reconhecível.
- Título muito "perfeito"/genérico sobre exatamente o tema do artigo.
- Páginas/volumes impossíveis; ano posterior à data do artigo; ano anterior à existência do periódico.
- Muitos autores com sobrenomes comuns e iniciais (padrão típico de alucinação).
