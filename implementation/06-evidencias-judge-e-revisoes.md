---
task: Entregar evidências gates judge opcional e revisões com aprovação limitada
engine: codex
---

# Subplano S06 — Evidências, judge e revisões

## Resultado do subplano

Cada attempt produz evidence bundle auditável. Completion pode ser determinística, self-review ou external judge. O judge retorna nota 0–100 e parecer detalhado; o Ralph aplica threshold/severidade e permite no máximo o número configurado de revisões. Gates bloqueantes sempre vencem.

## Referências obrigatórias

- `docs/07-prd-v2-subprds-e-skill.md`
- `docs/09-evidencias-gates-judge-e-revisoes.md`
- `docs/11-eventos-telemetria-logs-e-relatorios.md`
- `docs/12-tui-ux-layout-e-progresso.md`
- schemas de `docs/17-*`
- `docs/adr/0008-snapshot-imutavel-e-fronteira-tui-s06-s08.md`

## Tarefas

- [x] S06.01 implementar evidence store/content hashes e `EvidenceBundle` completo com task/criteria/limits, baseline/diff/files/artifacts, tool refs, commands/gates, context/profile/usage, prior assessments e truncation notices; disponibilizar inspect human/JSON.
- [x] S06.02 implementar registry/pipeline de gates `file`, `schema`, `command`, `test`, `lint`, `typecheck`, `build`, `git`, `artifact`, `security` e plugin, com blocking, conditions, platform, timeout, output refs e estados de skip distintos.
- [x] S06.03 implementar option/policy de `--skip-tests`, `--skip-lint`, `--skip-gates`, `--no-gates`, `--fast`, fail-fast e required overrides, mostrando origem/impacto e impedindo que skip seja registrado como pass.
- [x] S06.04 implementar no-change/change-only/artifact/criteria compositions, validando artifacts declarados por path/hash/schema e deixando explícito no report que diff/arquivo prova materialização, não necessariamente correção semântica.
- [x] S06.05 definir e validar o `JudgeAssessment` schema com score inteiro 0–100, summary, adequate, problems/severity, missing evidence, recommendations, criterion scores e confidence; adicionar fixtures inválidas, fora de range, truncadas e contraditórias.
- [x] S06.06 implementar bundle builder/prompt de avaliação neutro e bounded, `external-judge` por perfil independente e judge read-only, com structured output quando suportado e repair/retry de transporte separados de revisão.
- [x] S06.07 implementar `self-review` como chamada nova usando exatamente bundle/rubrica/schema do external judge e `deterministic-only` sem nota inventada; rotular origem em events/TUI/report.
- [x] S06.08 implementar evaluation policy que aplica gates primeiro, threshold configurável, mandatory severity/criteria e produz `CompletionDecision` Ralph; provar score 100 não superar blocking gate failure.
- [x] S06.09 implementar revision loop persistido: feedback anterior no context manifest, novo ordinal, coleta completa de evidence e judge novamente até `max_revision_attempts`; separar executor retry, judge transport retry, wiggum iteration e watchdog restart.
- [x] S06.10 integrar CLI/config e a inspeção TUI anexada para mode/profile/threshold/rubric/revision budget e parecer adequado/ruim/ausente/recomendações; o popup/resumo de um run já persistido é read-only e mostra valor efetivo, origem e equivalentes de config/CLI. Cenários judge unavailable seguem `deterministic|pause|fail` explícito. A command palette mutável, `Apply for this run` antes da criação do run e `Save workspace/global default` permanecem requisitos obrigatórios de S08.10/S08.12.
- [x] S06.11 executar E2E: deterministic pass, change-only, artifact, self-review, external score `60 -> revisão -> 88` com threshold 85, exhaustion, malformed judge e blocking gate + score 100; validar markers, counters, tokens e reports.
- [x] S06.12 fechar comandos top-level `verify` e `judge`: selectors exatos/fail-closed, suporte a source ad hoc persistida sem PRD/marker/gates inventados, operation/request/report/eventos duráveis, evidence fresca sem executor, external default/self explícito, backend judge read-only sem tools, score/threshold/parecer/IDs completos em human/JSON e zero mutação/aplicação de task. A matriz focada cobre selectors exatos e ambíguos, bindings de attempt/evidence/verification, receipts e objetos adulterados/ausentes, transição terminal ilegal, defaults external/self, eventos de provider, backend mutante, renderização human/JSON, source ad hoc e snapshots imutáveis de task/attempt/marker.

## Evidência executável atual

O gate consolidado passou com 673 testes e zero falhas; a suíte de integração passou com 149 e zero
falhas. A cobertura específica de S06 inclui `s06-gates`, `skip-completion-policy`,
`s06-completion-compositions`, `judge-domain`, `evaluation`, `judge-backends`, `judge-store`,
`s06-judge-runner`, `revision-recovery` e o entrypoint público `60 -> 88`. Os judges externos desses
testes são fixtures CLI determinísticas e read-only: nenhum smoke pago, login ou provider real é
alegado. A matriz dedicada `tests/integration/s06-command-evidence.test.ts` passou isoladamente com
3 testes, 69 asserções e zero falhas; essa é a evidência específica de S06.12 e não substitui um
novo rerun da suíte consolidada.

## Critérios de conclusão

- Todo `[x]` aponta para evidence bundle/decision.
- External e self usam o mesmo contrato; `none` não cria avaliação fictícia.
- Threshold e revisões respeitam precedência e aparecem em status.
- Parecer detalhado é persistido mesmo quando aprovado.
- Limite esgotado deixa task não concluída e recuperável.
- Skip/no-change/artifact são honestos e determinísticos.

## Verificação mínima

```text
ralph-next once --no-judge --prd <fixture>
ralph-next once --self-review --judge-threshold 75 --prd <fixture>
ralph-next once --judge external --judge-profile <fake-judge> --judge-threshold 85 --max-revisions 2 --prd <fixture>
ralph-next evidence inspect <attempt-id> --format json
```

S06.12 foi fechada pela matriz dedicada: task selector exige `--run-id`; positional sem prefixo
falha; attempt/evidence/verification IDs mantêm binding; `verify` não aceita evidence de outro
`verify`; o default de `judge` é external mesmo com default global deterministic; `--self-review`
usa perfil executor; provider usage/raw refs chegam aos eventos `judge.backend.*`; backend mutante
falha; e nenhum cenário altera `TaskRecord`, `AttemptRecord`, marker ou revision budget. A matriz
também adultera e remove objetos apontados pelos receipts, varia hash/tamanho/ref, tenta transição
terminal ilegal no ledger, valida saídas human/JSON e comprova separadamente estabilidade de
workspace e control state.
