# 09 — Evidências, gates, judge e revisões

## Princípio

A conclusão não depende da autodeclaração do executor. O Ralph monta um pacote de fatos, executa verificações determinísticas configuradas e só então, opcionalmente, solicita interpretação a um judge externo ou ao próprio executor.

Quanto mais determinística uma prova, maior sua prioridade. Uma nota alta nunca supera gate bloqueante falho.

## Evidence bundle

O bundle imutável de uma tentativa inclui, conforme disponibilidade:

- task compilada, resultado, critérios, limites e evidence mode;
- baseline/HEAD, branch/worktree e diff completo ou referências por hash;
- arquivos criados, alterados, removidos e fora do escopo;
- artifacts declarados, hashes, tamanho, MIME e validação;
- commands/gates com argv, cwd, exit code, duração, stdout/stderr truncado e refs para bruto;
- testes descobertos/rodados/pulados;
- eventos de tools e outcome do executor;
- context manifest e perfis/modelos usados;
- uso de tokens/custo e limites;
- tentativas/revisões anteriores e feedback não resolvido;
- diagnostics de segurança/sandbox;
- campos `reported`, `estimated` ou `unavailable` onde o provider não oferece dado.

O judge recebe uma representação bounded, com anexos referenciados e checksums. Falha de hash,
identidade, referência content-addressed ou schema do manifesto encerra a avaliação antes da chamada
ao modelo. Omissões esperadas por limite, retenção, conteúdo não textual ou indisponibilidade ficam
no campo `attachmentDiagnostics` do bundle e são tratadas explicitamente como missing evidence. Se
algo necessário foi truncado, isso também aparece no bundle; o prompt nunca finge completude.

## Ordem de verificação

1. Reconciliar workspace e detectar efeitos fora do escopo.
2. Confirmar evidence mode e requisitos mínimos.
3. Verificar no-change/diff/artifacts.
4. Rodar gates estruturais rápidos.
5. Rodar commands/tests/lint/build/security conforme policy.
6. Consolidar resultados determinísticos.
7. Bloquear imediatamente se um gate bloqueante falhar.
8. Executar avaliação selecionada se ainda aplicável.
9. Comparar nota com threshold e regras de mandatory findings.
10. Aprovar, solicitar revisão, bloquear ou falhar por limite.

## Tipos de gate

- `file`: existência, ausência, hash, tamanho ou glob;
- `schema`: JSON/YAML/TOML/PRD/schema customizado;
- `command`: exit code e opcional pattern/arquivo gerado;
- `test`, `lint`, `typecheck`, `build`: aliases de command com categoria;
- `git`: diff não vazio, paths permitidos, sem conflito, clean policy;
- `artifact`: registro e validação do entregável;
- `security`: segredo, dependência, permission ou scanner configurado;
- `manual`: aprovação humana explícita, somente quando o PRD exigir;
- plugin gate namespaced.

Cada gate possui ID, blocking, timeout, attempts, platform condition e skip policy. Não se assume npm, Bun, Python, Go ou qualquer ferramenta; o projeto declara commands.

## Manter as opções de skip/velocidade

O Ralph v2 deve conservar a capacidade de executar ciclos pequenos sem ficar preso indefinidamente em verificações desproporcionais:

- `--skip-tests`, `--skip-lint`, `--skip-gates <ids/categories>`;
- `--fast`, que expande para uma policy documentada e exibida antes do run;
- `--no-gates` somente se config/PRD permitir;
- `--fail-fast`;
- timeout por gate e total;
- `required`, `optional`, `allowed-to-skip` e `never-run` por gate;
- conditions por plataforma/arquivo alterado;
- resultado `skipped_by_cli`, `skipped_by_policy`, `not_applicable` ou `unavailable`, nunca apenas “pass”.

Um gate marcado obrigatório no PRD não pode ser ignorado por default global. Override perigoso requer flag explícita, audit event e deixa a task como `completed_with_override` ou não concluída conforme policy; não deve parecer aprovação normal.

## Operações standalone de evidência

`ralph-next verify` e `ralph-next judge` reutilizam os contratos deste capítulo sem fingir que são
attempts novas do executor:

- `verify` exige evidence de execução persistida, recupera o baseline durável da task, captura o
  workspace atual, reexecuta somente as verificações declaradas, coleta artifacts e persiste um
  `VerificationCommandReport` com uma evidence v2 nova;
- a evidence nova fica content-addressed e vinculada à operação, ao run, à task, à attempt fonte e
  à evidence fonte; ela não substitui o bundle oficial já ligado à attempt;
- o delta cumulativo continua sendo baseline da task até workspace atual; o delta da operação é
  pre-gate até pós-gate. Uma mutação causada por gate produz um gate interno bloqueante de estabilidade;
- `judge` consome exatamente um bundle de execução ou o bundle de um `verify` identificado por
  `--verification-id`, materializa os mesmos anexos bounded e usa o evaluator compartilhado;
- materialização persiste `judge.attachments.materialized` com amostra bounded, contagem total e
  indicador de truncamento; quebra de integridade falha fechado e limitações honestas entram
  integralmente na decisão local e, de forma bounded, em `attachmentDiagnostics`, portanto nenhuma
  ausência é descartada silenciosamente antes da nota;
- o default do comando `judge` é external, enquanto `--self-review` seleciona self. Ambos exigem
  backend sem tools e read-only e usam o mesmo schema/policy; deterministic/manual são rejeitados;
- retries do comando judge são somente chamadas de transporte/schema. Nenhum retry dispara executor,
  revisão de código ou consumo de `max_revision_attempts`;
- ambos persistem operation/request/report/eventos correlacionados, mas nunca alteram `TaskRecord`,
  `AttemptRecord`, marker `[ ]/[~]/[x]`, completion transaction ou revision budget. Task/attempt são
  relidos antes/depois: divergência gera gate bloqueante em `verify` ou decisão failed em `judge`,
  separada da estabilidade dos arquivos;

As operações também suportam runs ad hoc. Nesse caso a definição virtual é reproduzida apenas da
descrição/hash persistidos pela run: task `request`, evidence mode `change-only`, criteria e
verification vazios, workspace `.` e marker inexistente. Falta de source persistida é conflito;
o runtime não tenta abrir `@ad-hoc/...` como arquivo nem cria uma especificação substituta. O
`verify` reaplica sobre o delta cumulativo desde o baseline a proteção builtin contra criação ou
alteração de PRD: nome convencional, conteúdo v2/classic, symlink e Markdown cuja leitura/intenção
PRD não possa ser classificada com segurança produzem gate interno bloqueante. A mudança é
preservada para inspeção; task, attempt e marker continuam intocados.

## No-change e último recurso

Políticas:

- `require-change`: exige diff permitido não vazio;
- `allow-no-change`: aceita nenhum diff se outros critérios comprovarem conclusão preexistente;
- `fail-on-no-change`: falha imediata;
- `retry-on-no-change`: permite nova executor attempt até limite;
- `artifact-required`: exige arquivo declarado mesmo se não houver source diff;
- `change-only`: diff permitido é a evidência primária quando não existe oracle melhor.

Para tarefas intrinsecamente não materiais, a skill deve declarar um artifact útil: ADR, relatório, mapa, fixture, snapshot, manifesto, arquivo de decisão. O runtime nunca ordena ao modelo criar um arquivo arbitrário depois do fato. O arquivo é parte do contrato original e seu aparecimento gera Git diff auditável.

## Modos de avaliação

### `deterministic-only`

Sem LLM julgadora. Completion decorre exclusivamente de gates/evidence mode. É o default mais previsível quando critérios são suficientes.

### `external-judge`

Usa perfil independente. É o modo preferencial quando se deseja reduzir viés de autoavaliação.

### `self-review`

Opcional quando não existe judge externo. O executor recebe exatamente o mesmo contrato de avaliação, evidence bundle e schema do judge. A resposta não altera gates e deve ser rotulada `self`. Pode usar uma nova chamada/contexto para reduzir contaminação, mas continua não independente.

### `manual`

Somente para task/critério que exige decisão humana. O run entra em waiting state e pode ser retomado via comando/TUI. Headless tem timeout/policy explícita.

Sem judge e sem self-review, o Ralph não inventa uma nota: `assessment.status=not_requested`, e a policy determinística decide.

## Contrato do judge

Input:

- descrição integral compilada da task;
- definição de completion/evidence mode;
- deterministic results;
- diff/artifacts/output relevante;
- feedback anterior;
- rubrica e regras de score;
- instrução read-only e schema de saída.

Saída estruturada:

```json
{
  "schemaVersion": 1,
  "score": 82,
  "summary": "A slice funciona no fluxo principal, mas falta prova do estado de erro.",
  "adequate": ["Contrato API e UI estão conectados", "Teste principal passou"],
  "problems": [
    {"severity": "major", "criterion": "C2", "message": "Estado 500 não foi exercitado", "evidenceRefs": []}
  ],
  "missingEvidence": ["Resultado do cenário de erro end to end"],
  "recommendations": ["Adicionar fixture 500 e asserção de mensagem da UI"],
  "criterionScores": [{"criterion": "C1", "score": 100}, {"criterion": "C2", "score": 55}],
  "confidence": 0.84
}
```

Regras:

- score inteiro entre 0 e 100;
- parecer sempre traz adequado, ruim/problemas, evidência ausente e recomendações, mesmo que arrays vazios;
- severidade `info`, `minor`, `major`, `critical`;
- findings citam criterion/evidence sempre que possível;
- resposta é validada por schema;
- o Ralph, e não o judge, calcula `passed = score >= threshold` mais regras de severidade;
- `critical` pode reprovar independentemente do score se a policy declarar;
- judge nunca recebe token/tool para escrever ou mudar estado.

## Threshold e rubrica

O threshold é configurável por perfil/run/task, em 0–100, com default documentado. Precedência segue `docs/04-*`. O relatório registra valor e origem efetiva.

Uma rubrica pode ponderar critérios, mas o score final ainda é 0–100. Pesos somam 100 ou são normalizados explicitamente. Critério sem evidence não ganha pontuação automaticamente. Gates determinísticos falhos não são “compensados” pela média.

Exemplos:

```text
--judge external --judge-threshold 85 --max-revisions 2
--self-review --judge-threshold 75
--no-judge
```

As formas canônicas de configuração são `--evaluation external`, `--evaluation self` e
`--evaluation deterministic-only`. Os aliases acima não aceitam `self` ou `none` como argumento de
`--judge`: isso evita que duas sintaxes parcialmente sobrepostas produzam precedência ambígua.

## Revisões

Após reprovação válida:

1. Persistir assessment completo.
2. Calcular se há revision budget.
3. Construir novo context manifest com um resource estruturado, bounded e hash-bound contendo o feedback, diff atual e itens ainda ausentes; `previousAssessmentRef` permanece apenas como vínculo de auditoria e não obriga o executor a ler `.ralph`.
4. Criar `revisionAttempt = anterior + 1`, sem apagar histórico.
5. Invocar executor, coletar nova evidence e repetir gates/judgment.
6. Aprovar se threshold/regras forem atingidos.
7. Ao esgotar `max_revision_attempts`, terminar como `rejected`/`blocked_by_judge` e manter task não concluída.

`max_revision_attempts` conta modificações motivadas por assessments válidos. Não conta falhas de transporte/schema do judge; estas usam `judge_transport_retries`. Também não se confunde com executor retry transitório.

O valor zero significa avaliar uma vez e não permitir correção. A TUI mostra `revisão 1/2`, nota anterior, threshold e feedback aberto.

## Falhas do judge

- timeout/rate limit: retry conforme policy, depois fallback explícito ou `evaluation_unavailable`;
- JSON inválido: uma repair request bounded, depois retry/erro;
- credencial inválida: falha operacional, sem fallback implícito para self-review;
- evidence grande: bundle builder deve resumir deterministicamente e referenciar anexos, não cortar silenciosamente;
- contradição com gate: gate vence e discrepância é reportada;
- nota fora do range: schema failure, não clamp silencioso.

Uma policy pode permitir `on_judge_unavailable: deterministic`, `pause`, ou `fail`. O default seguro para judge obrigatório é `pause/fail`, não aprovar.

## Critérios de aceite

- Toda conclusão aponta para evidence bundle reproduzível.
- Gates bloqueantes vencem qualquer nota.
- Judge externo e self-review usam o mesmo schema/rubrica.
- Threshold e máximo de revisões são configuráveis e aparecem na TUI/relatório.
- O parecer apresenta o que está adequado e o que está ruim/ausente.
- Sem judge, deterministic-only continua plenamente funcional.
- Tarefas sem critério forte podem usar change/artifact declarado sem inventar validade semântica.
- Limites esgotados mantêm a task não concluída e retomável.
