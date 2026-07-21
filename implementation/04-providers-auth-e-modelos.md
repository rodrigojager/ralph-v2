---
task: Entregar providers modelos e autenticação independentes para executor e judge
engine: codex
---

# Subplano S04 — Providers, auth e modelos

## Resultado do subplano

O usuário consegue listar providers/modelos, configurar perfis separados, conectar credenciais por métodos suportados e fazer smoke calls read-only. A primeira integração de conta/assinatura — incluindo ChatGPT Plus/Pro quando o commit upstream permitir — usa driver embutido. Código derivado do OpenCode possui provenance completa.

## Referências obrigatórias

- `docs/05-configuracao-perfis-e-tui.md`
- `docs/06-providers-modelos-autenticacao-e-upstream.md`
- `docs/11-eventos-telemetria-logs-e-relatorios.md`
- `docs/14-compatibilidade-migracao-distribuicao-e-licencas.md`
- `docs/17-contratos-e-schemas.md`

## Tarefas

- [x] S04.01 selecionar e fixar o commit OpenCode real da implementação, reconfirmar licença, criar `third_party/opencode/{LICENSE,PROVENANCE.json,UPSTREAM.md,copied-files.md,patches.md}` e `THIRD_PARTY_NOTICES.md`, inventariar somente source/dependencies necessários e registrar explicitamente o que não será copiado.
- [x] S04.02 implementar ports `ProviderDriver`, `CredentialDriver`, `ModelCatalog` e `ModelRouter`, registry lazy e contract test fake; reforçar por dependency boundaries que drivers não importam orchestration, PRD, Git, completion ou persistence público.
- [x] S04.03 adaptar curadamente metadata/registro de um conjunto inicial de providers e modelos, normalizar capabilities/limits/variants/access/usage/pricing source, cachear snapshot com TTL e expor `providers list`, `models list`, `models inspect` human/JSON.
- [x] S04.04 implementar `CredentialRef` e secret-store abstraction, começando por OS credential manager/keychain e environment reference com fake de teste; conectar/listar/status/revogar sem persistir valor e aplicar redaction canary em config/events/logs/report.
- [x] S04.05 implementar API key flow seguro por CLI/TUI input e environment, evitando segredo em argv/history quando possível, validando credential/provider match e oferecendo diagnóstico de expiração/permissão sem imprimir header/token.
- [x] S04.06 adaptar um fluxo OAuth/account suportado com state/PKCE/callback ou device flow, refresh/revoke e mocks determinísticos; timeouts/cancelamento e navegador não disponível devem gerar instrução headless acionável.
- [x] S04.07 implementar especificamente o fluxo de conta ChatGPT Plus/Pro para o driver Codex/OpenAI quando suportado pelo upstream fixado, distinguir subscription de OpenAI API key, fazer smoke opt-in real rotulado e falhar fechado em elegibilidade/alteração de protocolo, sem chamar o executável `codex`.
- [x] S04.08 implementar `RoleProfile` para executor/judge, fallback explícito e capability validation, com config global/workspace, CLI `--executor-*`/`--judge-*` e popup mínimo compartilhando metadata; provar duas credenciais/providers independentes.
- [x] S04.09 implementar smoke model call read-only/sem tools pelo event adapter inicial, normalizando text/reasoning/finish/error/usage e preservando raw; distinguir usage reported/estimated/unavailable e não somar snapshots cumulativos.
- [x] S04.10 adicionar golden streams, auth/refresh/expiry/rate-limit tests, provider unavailable/fallback policy, docs de conexão/desconexão e license/dependency gate; atualizar copied-files/hashes no mesmo commit de cada source adaptado.

## Critérios de conclusão

- Perfis de executor e judge resolvem independentemente.
- Nenhum segredo aparece no config, output ou logs de teste.
- Login de conta suportado funciona pelo driver embutido, sem usar Codex CLI.
- Catálogo filtra capabilities e registra snapshot usado.
- Fallback só ocorre para classes autorizadas.
- Todo source derivado é mapeado para commit/licença/teste.

## Verificação mínima

```text
ralph providers list --format json
ralph auth connect <provider> --method <method>
ralph auth status --format json
ralph models list --provider <provider>
ralph model smoke --profile <profile> --format json
```
