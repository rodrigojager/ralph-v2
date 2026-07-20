# ADR 0008 — Snapshot imutável e fronteira TUI entre S06 e S08

- Estado: aceita
- Data: 2026-07-18
- Slices: S06 e S08
- Documentos relacionados: `docs/05-configuracao-perfis-e-tui.md`, `docs/09-evidencias-gates-judge-e-revisoes.md`, `docs/10-persistencia-retomada-watchdog-e-filhos.md`, `docs/12-tui-ux-layout-e-progresso.md`, `docs/16-plano-de-implementacao-vertical.md`, `docs/17-contratos-e-schemas.md`, `implementation/06-evidencias-judge-e-revisoes.md`, `implementation/08-eventos-telemetria-e-tui.md`

## Contexto

S06 precisa provar que mode de avaliação, perfil, threshold, rubrica, budget de revisões e parecer são observáveis de ponta a ponta. Seu subplano mencionava CLI, config, popup e resumo TUI. Ao mesmo tempo, o roadmap reserva para S08 a command palette, os popups ricos, os command models compartilhados e o E2E PTY de apply/save.

Interpretar o popup anexado de S06 como editor do run persistido criaria duas violações. Primeiro, options, evidence e decisões anteriores deixariam de representar a policy que realmente governou as attempts. Segundo, S06 anteciparia apenas uma versão parcial da edição rica cuja entrega vertical completa pertence a S08. Interpretar S06 como dispensa dos popups mutáveis, por outro lado, removeria requisitos explícitos de `docs/12-*`, S08.10 e S08.12.

## Decisão

### Snapshot persistido

Quando um run é criado e persistido, seu `EffectiveRunOptions` e hash formam um snapshot imutável. Cada attempt conserva também o snapshot efetivo resolvido para sua task. Attach, replay, status, report e TUI projetam esses fatos; não os reescrevem.

Uma ação operacional posterior que precise ampliar capacidade de recuperação — por exemplo, uma concessão explícita de revisões após esgotamento — usa comando, autorização, record e evento append-only próprios. Ela não troca silenciosamente o threshold, o perfil, a rubrica ou o budget original e não altera o hash do snapshot.

### Entrega S06

S06 fornece:

- resolução e precedência completas por CLI/config para as opções de avaliação;
- persistência de valor efetivo, origem e referência de origem;
- attach com popup/resumo read-only de mode, profile, threshold, rubric, revision budget e policy de judge indisponível;
- equivalentes de config/CLI e impacto de cada campo;
- parecer com áreas adequado, problemas, ausente e recomendações, além de score/revisões/usage quando aplicáveis.

Essa inspeção é uma fatia utilizável e auditável, mas não é a superfície de configuração rica final.

### Entrega obrigatória S08

S08 continua obrigada a implementar a command palette e os popups mutáveis de `docs/12-*`, compartilhando metadata, validators e command handlers com o modo headless. As ações têm semântica distinta:

- `Apply for this run` aplica o draft à invocação antes de o novo run ser persistido;
- `Save workspace default` grava atomicamente a camada do workspace;
- `Save global default` grava atomicamente a camada global.

Durante attach/replay de um run existente, o popup continua read-only quanto àquele snapshot. Saves podem editar defaults de runs futuros; apply para o run atual fica indisponível com explicação. Criar outro run a partir desses valores é uma nova invocação e uma nova identidade de run.

S08.12 deve provar por E2E PTY apply pré-run, os dois saves, a origem resultante, attach/replay sem mutação, close/background/reattach e paridade com human/JSON/event replay. A projeção S06 não satisfaz nem reduz esse gate.

## Consequências

- Evidence, resume e report continuam auditáveis contra a policy exata usada na execução.
- A TUI não ganha uma rota local para alterar regras de negócio ou records persistidos.
- S06 possui um resumo visual real sem antecipar a infraestrutura completa de settings de S08.
- Todos os requisitos finais de popups de `docs/12-*` permanecem obrigatórios e testáveis em S08.
- Configuração salva enquanto um run está anexado só afeta runs futuros, evitando mudança retroativa difícil de perceber.

## Evidência esperada

- teste S06 projeta valores, origens, source refs e equivalentes a partir do `EffectiveRunOptions` persistido;
- teste S06 prova que attach/replay não oferece mutação daquele snapshot;
- teste S08 aplica um draft pré-run e encontra os valores/origens no novo snapshot;
- testes S08 salvam workspace/global pelos handlers compartilhados e provam precedência em runs futuros;
- teste S08 tenta aplicar override ao run anexado e recebe estado indisponível explícito, sem mudança de hash/record;
- teste de recuperação prova que grants/retries operacionais são append-only e não alteram `EffectiveRunOptionsHash`.
