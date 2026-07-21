# 20 — Guia operacional de providers, autenticação e modelos na S04

Este guia descreve a superfície entregue pela S04. Ele complementa os contratos
normativos de [configuração](05-configuracao-perfis-e-tui.md),
[providers](06-providers-modelos-autenticacao-e-upstream.md),
[telemetria](11-eventos-telemetria-logs-e-relatorios.md),
[licenças](14-compatibilidade-migracao-distribuicao-e-licencas.md) e
[schemas](17-contratos-e-schemas.md).

O Ralph continua sendo a autoridade. Catálogo, credenciais e modelos são
ferramentas chamadas por comandos do CLI; nenhum driver escolhe tarefas, altera
markers, autoriza tools ou persiste conclusão.

## Escopo honesto da slice

A S04 oferece:

- catálogo validado e cacheado de providers e modelos;
- credenciais por API key, referência de variável de ambiente e fluxos de conta
  ChatGPT anunciados pelo driver OpenAI;
- perfis independentes de executor e judge, persistidos globalmente ou no
  workspace;
- um formulário TTY mínimo para configurar perfil;
- chamada de diagnóstico read-only, sem tools, pelos drivers OpenAI e OpenRouter embutidos;
- eventos normalizados, usage com fonte declarada e raw record redigido e
  content-addressed;
- contratos públicos e provenance do código curado do OpenCode.

Esta slice **não** transforma o smoke em executor de tarefas. O backend de
produção que usa tools e executa um PRD entra na S05. OpenRouter possui agora
adapter embutido pelo endpoint Responses compatível fixado, somente para API key
ou referência de environment; o protocolo beta não é tratado como promessa de
estabilidade nem como acesso de assinatura. Anthropic continua disponível para
catálogo, credential ref e configuração de perfil, mas permanece `unknown` e
sem driver embedded. A TUI rica com popups e painéis pertence à S08.

O endpoint e o shape compatível seguem a documentação oficial do
[OpenRouter Responses API](https://openrouter.ai/docs/api/reference/responses/overview), que o
classifica como beta. O adapter fixa `https://openrouter.ai/api/v1/responses`; configuração de
workspace não pode redirecionar a credential para outra origem.

## Catálogo de providers e modelos

### Comandos

```text
ralph providers list [--refresh] [--format human|json|jsonl]
ralph providers inspect <provider> [--refresh] [--format human|json|jsonl]

ralph models list [--provider <provider>] [--require-tools]
  [--require-structured-output] [--refresh] [--format human|json|jsonl]

ralph models inspect <provider>/<model> [--refresh]
  [--format human|json|jsonl]
ralph models inspect <model> --provider <provider> [--refresh]
  [--format human|json|jsonl]
```

Para um model ID que já contém `/`, como os IDs do OpenRouter, use a segunda
forma para desambiguar:

```text
ralph models inspect openai/gpt-5.3-codex --provider openrouter --format json
```

`providers inspect` mostra access e apenas os métodos de autenticação realmente
anunciados pelo provider. `models inspect` mostra capabilities, limites,
variantes, access `api|subscription`, status e metadata de preço. Preço é
informativo e registra origem e data; na curadoria atual ele se aplica a API,
não ao consumo de uma assinatura ChatGPT.

Cada resposta inclui o `snapshotId`, a origem da resolução e se o snapshot é
stale. As origens possíveis são:

- `source`: leitura nova de Models.dev validada por schema Ralph;
- `cache`: snapshot local ainda dentro do TTL;
- `stale-cache`: a fonte falhou e o último snapshot válido foi preservado com
  warning;
- `fallback`: snapshot curado e fixado no repositório.

Cada comando resolve exatamente um snapshot e deriva dele tanto o payload
quanto os filtros, validações e provenance apresentados. O CLI não rotula
dados de uma segunda leitura com o ID da primeira; o smoke empacotado cruza os
IDs de provider, model e perfil entre os comandos públicos.

O TTL padrão é 24 horas. `--refresh` força uma tentativa de atualização, mas não
autoriza executar código remoto: Models.dev é tratado somente como dado não
confiável, com limite de bytes, timeout, schema fechado, hash e escrita atômica.
O cache padrão fica ao lado da configuração global, em
`cache/model-catalog.json`.

Na curadoria atual, OpenAI e OpenRouter estão `available`; Anthropic permanece
`unknown`. Um model constar no catálogo ou possuir adapter não prova credencial,
quota, elegibilidade da conta, compatibilidade dinâmica do modelo ou disponibilidade da API.

## Credenciais

### API key sem segredo em argv

Em um terminal interativo, omitir `--secret-stdin` abre entrada mascarada:

```text
ralph auth connect openai --method api-key \
  --credential openai-main --label "OpenAI principal"
```

Em automação, envie o segredo pelo stdin. O comando que produz o segredo é
apenas ilustrativo; use o secret manager do seu ambiente e não escreva o valor
literal no histórico:

```text
<secret-provider-command> | ralph auth connect openai --method api-key \
  --credential openai-ci --label "OpenAI CI" \
  --secret-stdin --non-interactive --format json
```

O parser não possui `--api-key` nem outro flag que aceite o valor. Em modo
`--non-interactive`, API key exige `--secret-stdin`.

### Referência de variável de ambiente

Este método persiste somente o nome da variável:

```text
ralph auth connect openai --method environment \
  --credential openai-env --environment OPENAI_API_KEY \
  --non-interactive --format json
```

O valor é resolvido somente quando necessário. Nem config, metadata pública,
eventos ou relatórios recebem uma cópia do segredo.

### Conta ChatGPT Plus/Pro

O driver OpenAI/Codex é embutido; os comandos abaixo **não** chamam o executável
`codex` e não transformam o OpenCode em orquestrador.

Fluxo no navegador com state, PKCE e callback loopback:

```text
ralph auth connect openai --method oauth-browser \
  --credential chatgpt-main --label "ChatGPT pessoal"
```

Fluxo device code, adequado para terminal headless:

```text
ralph auth connect openai --method device-code \
  --credential chatgpt-headless --headless --timeout 600
```

`subscription-session` usa o mesmo contrato de conta: navegador quando
interativo e device flow quando combinado com `--headless`.

```text
ralph auth connect openai --method subscription-session \
  --credential chatgpt-subscription
```

`oauth-browser --headless` e `oauth-browser --non-interactive` falham com um
diagnóstico tipado e orientação explícita para usar `device-code`, pois o
callback local precisa de um navegador/usuário. O callback faz bind somente em
loopback. Tokens são renovados em um locator novo no secret store quando
expirados ou quando
`auth status --refresh` pede renovação. Conta, região, modelo ou protocolo não
elegível falham fechados: não há troca silenciosa para API key, CLI externo ou
outro provider.

Esses fluxos têm cobertura determinística com mocks e golden streams. Isso não
equivale a afirmar que uma conta real do usuário já foi conectada ou testada.

### Listar, verificar e revogar

```text
ralph auth list [--provider <provider>] [--format human|json|jsonl]
ralph auth status [<credential>] [--provider <provider>] [--refresh]
  [--format human|json|jsonl]
ralph auth revoke <credential> [--format human|json|jsonl]
```

`auth list` expõe apenas `CredentialRef`. `auth status` retorna estado como
`connected`, `expired`, `unavailable`, `revoked` ou `unknown`, sem testar o
segredo por impressão. `--refresh` pode renovar credenciais de assinatura.

`auth revoke` remove a credencial do secret store e o metadata local. Revogação
remota só é tentada quando o protocolo fixado possui endpoint estável. O fluxo
ChatGPT fixado na S04 não oferece um endpoint remoto estável; nesse caso o
comando é logout/revogação **local**, e o usuário deve encerrar sessões remotas
pelos controles da própria conta quando necessário.

A limpeza local não depende da disponibilidade atual do catálogo nem de o
provider continuar anunciando o método usado originalmente. Se uma tentativa
de revogação remota falhar, o Ralph ainda remove secret e metadata locais e
retorna o diagnóstico tipado
`RALPH_CREDENTIAL_REMOTE_REVOKE_UNCONFIRMED`, com
`localRevoked: true` e `remoteRevoked: false`; mensagens brutas do endpoint não
são expostas.

Renovação e revogação concorrentes no mesmo processo são serializadas e nunca
deixam locator órfão. Se outro comando renovar a referência entre a listagem e
a revogação, a revogação com a referência antiga falha como stale e deve ser
repetida pelo ID; o metadata aponta para o locator novo e permanece íntegro.
Coordenação durável entre processos e retry supervisionado pertencem às slices
de concorrência/recuperação posteriores, não à S04.

### Secret stores por plataforma

O runtime S04 usa o credential store do sistema:

| Plataforma | Backend |
| --- | --- |
| Windows | Windows Password Vault, acessado por PowerShell sem segredo em argv |
| macOS | Keychain via `/usr/bin/security` |
| Linux | Secret Service via `secret-tool` |

O metadata global contém locator, provider, método, label, hint e expiração,
nunca o valor. A referência `environment` mantém somente o nome da variável.
O runtime atual falha se o keychain necessário estiver indisponível; embora o
parser reconheça `--allow-insecure-store`, a composition S04 recusa storage
plaintext. Não existe fallback silencioso para arquivo inseguro.

## Perfis independentes de executor e judge

Um perfil liga role, backend, provider, model, credential ref, variante,
requirements, limites e fallback. Executor e judge nunca compartilham uma
credencial por inferência.

Crie primeiro os perfis que serão usados como fallback e depois o perfil que os
referencia. Exemplo de dois executores OpenAI:

```text
ralph profiles configure executor-backup \
  --scope global --role executor --backend embedded \
  --provider openai --model gpt-5.4-mini --credential openai-main

ralph profiles configure executor-main \
  --scope global --role executor --backend embedded \
  --provider openai --model gpt-5.4 --credential chatgpt-main \
  --variant high --require-tools \
  --fallback-profile executor-backup \
  --fallback-on provider-unavailable --fallback-on rate-limit
```

Um judge pode usar credencial e provider distintos:

```text
ralph profiles configure judge-main \
  --scope workspace --workspace <projeto> \
  --role judge --backend embedded \
  --provider anthropic --model claude-sonnet-4-6 \
  --credential anthropic-judge --require-structured-output
```

Esse exemplo prova a independência da configuração; não afirma que o driver
Anthropic executa avaliações na S04. Execução e judge entram nas slices S05 e
S06.

Consultas:

```text
ralph profiles list [--role executor|judge] [--workspace <projeto>]
ralph profiles inspect <profile> [--workspace <projeto>] --format json
```

`profiles inspect` resolve origem de config, model/capabilities e metadata da
credential ref sem expor o segredo. A configuração valida provider da
credencial, role dos fallbacks, existência e ciclos.

`--fallback-profile` é repetível e preserva ordem. `--fallback-on` também é
repetível e aceita somente:

- `provider-unavailable`;
- `model-unavailable`;
- `rate-limit`;
- `transient`.

Falha de autenticação, schema, gate, reprovação do judge ou limite de budget não
ganha fallback implícito. A S04 materializa e valida essa política; o smoke
diagnóstico não é um loop de execução nem uma demonstração de fallback entre
perfis.

### Precedência e escopo

Perfis globais ficam no `config.yaml` da plataforma; perfis de workspace ficam
em `.ralph/config.yaml`. A precedência das opções de execução continua:

```text
CLI > task > PRD > config efetiva
config efetiva: env suportada > workspace > global > builtin
```

Os arquivos usam `snake_case`, por exemplo:

```yaml
schema_version: 1
profiles:
  executor-main:
    role: executor
    backend: embedded
    provider: openai
    model: gpt-5.4
    credential: chatgpt-main
    variant: high
    parameters: {}
    requirements:
      input: []
      tools: true
      tool_streaming: false
      reasoning: false
      structured_output: false
      usage: []
      access: []
    fallback_profiles:
      - executor-backup
    fallback_on:
      - provider-unavailable
      - rate-limit
    limits: {}
```

`credential` é um ID, nunca token. A escrita é atômica e substitui o perfil
completo validado. Sem flags suficientes, `profiles configure` abre o formulário
TTY mínimo; `--non-interactive` exige todos os campos obrigatórios e
`--scope global|workspace`. Esse formulário compartilha metadata de campo,
chave e flag com o CLI. Os popups ricos e a command palette chegam na S08.

Durante uma futura execução, os overrides continuam separados:

```text
--executor-profile --executor-provider --executor-model
--executor-credential --executor-variant --executor-parameter
--clear-executor-credential --clear-executor-variant --clear-executor-parameters

--judge-profile --judge-provider --judge-model
--judge-credential --judge-variant --judge-parameter
--clear-judge-credential --clear-judge-variant --clear-judge-parameters
```

A ausência de override preserva; `null`/mapa vazio materializados pelas flags `--clear-*` removem
explicitamente credential/variant e substituem parameters por `{}`. A S04 já resolve e persiste
esses valores nas opções efetivas, mas não reivindica
que o smoke read-only seja um executor de PRD.

## Model smoke read-only

Por perfil:

```text
ralph model smoke --profile executor-main --timeout 30 --format json
```

Ou por componentes explícitos:

```text
ralph model smoke --provider openai --model gpt-5.4-mini \
  --credential openai-main --variant medium --timeout 30 --format json
```

`--refresh` também força atualização do catálogo antes da chamada. O comando:

- usa um prompt fixo de diagnóstico;
- exige `readOnly: true`;
- envia `tools: []`;
- não altera workspace, PRD ou state de task;
- valida provider/model/variant/access contra o snapshot;
- aceita OpenAI e OpenRouter; Anthropic permanece fail-closed sem driver;
- usa API key/assinatura no OpenAI e somente API key/environment no OpenRouter;
- aplica timeout e falha com exit code `6` para auth/provider/model
  indisponível.

O resultado JSON pode conter texto, finish reason, eventos normalizados, usage
e `rawRef`. Usage informa `source` (`reported`, `derived`, `estimated` ou
`unavailable`) e `semantics` (`delta`, `cumulative` ou `final`); ausência de
contadores vira `unavailable`, não número inventado.

O raw record é redigido antes de persistir, recebe hash SHA-256 e uma referência
portável como:

```text
raw://model-smoke/<scope-sha256>/<content-sha256>
```

Ele fica no data root global em
`raw/model-smoke/<scope-sha256>/<content-sha256>.json`. O primeiro hash
particiona somente o workspace/cwd e permanece estável quando a policy muda;
assim a policy corrente continua varrendo todas as capturas daquele escopo sem
atravessar outro projeto. A captura atual mantém um lease ativo durante a
retenção e é protegida naquela passagem, evitando devolver uma referência que a
própria retenção acabou de apagar. A escrita content-addressed compartilha o
lease de retenção, valida ancestry e binding lstat/fstat e falha em bytes
conflitantes. Capturas legadas `raw://sha256/...` continuam somente legíveis, sem
ser usadas para novas gravações. O arquivo usa
permissão restrita quando a plataforma suporta, e registra snapshot/origem do
catálogo, eventos do driver e erro sanitizado quando houver. A referência, não
um path absoluto da máquina, atravessa o contrato público.

O adapter limita bytes, profundidade/nós estruturais, frames e eventos; rejeita
sequência ou terminal contraditório; e preserva somente summaries públicas de
reasoning. Conteúdo privado/encriptado de raciocínio é substituído por um
marcador de omissão também no raw. Timeout/cancelamento fecha o sink para que
nenhum evento tardio apareça depois do resultado. Falhas de provider produzem
evidência normalizada e redigida `model.provider.error`, além do raw seguro.

## Smoke real é opt-in

Os testes normais usam mocks e fixtures e não consomem conta ou créditos. Existe
um teste OpenAI real explicitamente opt-in:

```text
RALPH_S04_REAL_PROVIDER_SMOKE=1
OPENAI_API_KEY=<fornecida pelo ambiente ou secret manager>
bun test tests/integration/s04-real-openai-smoke.test.ts
```

No PowerShell, defina as variáveis no processo por um mecanismo seguro antes de
executar o último comando. `RALPH_S04_REAL_OPENAI_MODEL` pode selecionar outro
model; o default do harness é `gpt-5.4-mini`. Sem a flag de opt-in, o teste é
skipped. A existência desse harness não é evidência de que ele foi executado
com uma credencial real neste checkout.

### ChatGPT Plus/Pro real por device code

Um segundo teste, separado do harness por API key, cobre a conta ChatGPT
Plus/Pro. O callback imprime URL/código/instruções de device authorization, mas
nenhum token. O teste não possui opção de token em argv, ambiente ou config: o
token só nasce no fluxo embutido e segue para o keychain do sistema.

```powershell
$env:RALPH_S04_REAL_CHATGPT_SMOKE = '1'
$env:RALPH_S04_REAL_CHATGPT_MODEL = 'gpt-5.4-mini' # opcional, catálogo curado
try {
  bun test tests/integration/s04-real-chatgpt-subscription-smoke.test.ts
} finally {
  Remove-Item Env:RALPH_S04_REAL_CHATGPT_SMOKE -ErrorAction SilentlyContinue
  Remove-Item Env:RALPH_S04_REAL_CHATGPT_MODEL -ErrorAction SilentlyContinue
}
```

Sem `RALPH_S04_REAL_CHATGPT_SMOKE=1`, o teste é skipped. Com o opt-in, ele:

1. cria data root temporário e ID de credential únicos e os informa para
   recuperação, sem imprimir segredo;
2. resolve o model no catálogo curado e exige acesso `subscription`;
3. inicia `device-code` headless e permite até 15 minutos para autorização;
4. exige OS keychain, sem fallback para plaintext;
5. executa o prompt fixo read-only com `tools: []` e valida resposta, snapshot e
   `rawRef` SHA-256 redigida;
6. no `finally`, chama revogação local e remove somente o diretório temporário
   exato criado pelo teste.

Riscos: há login e chamada reais, com possível consumo de limites da assinatura;
a conta pode não ser elegível; o keychain pode estar indisponível; e drift do
protocolo fixado deve fazer o fluxo falhar fechado. A revogação ChatGPT desta
versão é local, não uma promessa de encerramento da sessão remota.

Se o processo for morto antes do `finally`, use o data root e o credential ID
impressos para executar `auth revoke` apontando `RALPH_CONFIG_HOME` para aquele
diretório:

```powershell
$env:RALPH_CONFIG_HOME = '<DATA_ROOT_EXATO_IMPRESSO>'
try {
  bun --silent apps/ralph-cli/src/main.ts auth revoke '<CREDENTIAL_ID_IMPRESSO>' --format json
} finally {
  Remove-Item Env:RALPH_CONFIG_HOME -ErrorAction SilentlyContinue
}
```

Só depois remova manualmente o caminho temporário, conferindo que é o alvo
exato sob o diretório temporário e que o nome começa com
`ralph-s04-real-chatgpt-`. Nunca forneça um token durante essa recuperação. A
presença do harness não é evidência de execução real neste checkout.

## Origem OpenCode e exceção de protocolo

O port curado está fixado no commit OpenCode
`45cd8d76920839e4a7b6b931c4e26b52e1495636`, versão upstream `1.18.3`, licença
MIT. A origem completa fica em:

- [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md);
- [`third_party/opencode/LICENSE`](../third_party/opencode/LICENSE);
- [`third_party/opencode/PROVENANCE.json`](../third_party/opencode/PROVENANCE.json);
- [`third_party/opencode/UPSTREAM.md`](../third_party/opencode/UPSTREAM.md);
- [`third_party/opencode/copied-files.md`](../third_party/opencode/copied-files.md);
- [`third_party/opencode/patches.md`](../third_party/opencode/patches.md).

`PROVENANCE.json` é a autoridade determinística para os hashes, relações source/destination, patches,
licença e exceções nominais. Os arquivos Markdown acima continuam sendo a explicação humana e são
validados contra o manifesto pelo gate de release.

O Ralph não incorpora o agente, session runner, servidor, banco, plugin host,
branding ou TUI do OpenCode. O código derivado está limitado ao protocolo de
conta ChatGPT/Codex e a conceitos curados de catálogo/provider, atrás de ports
Ralph.

O parâmetro `originator=opencode` é preservado porque pertence ao protocolo
fixado de autorização/request. Ele é uma exceção documentada: não é User-Agent,
branding, identidade do CLI nem alegação de afiliação. O User-Agent do driver é
Ralph (`ralph/...`) e pode ser injetado. Alterar a exceção exige vendor
refresh revisado; drift de protocolo falha fechado.

## Schemas públicos

A árvore `schemas/` contém 29 JSON Schemas gerados dos validators runtime. Os
oito contratos materializados pela S04 são:

- `credential-ref.schema.json`;
- `provider-info.schema.json`;
- `model-info.schema.json`;
- `role-profile.schema.json`;
- `token-usage.schema.json`;
- `provider-event.schema.json`;
- `provider-model-result.schema.json`;
- `model-catalog-snapshot.schema.json`.

Use `bun run schemas:check` para detectar ausência, arquivo extra ou divergência
em relação à fonte Zod. Credenciais secretas não fazem parte desses schemas.

## Relação com `/goal`

O `/goal` do Codex é apenas o mecanismo usado durante a construção deste
repositório. O produto resultante é o CLI independente `ralph`: ele lê PRDs
e Sub-PRDs Ralph, escolhe tarefas por seus próprios comandos e usa os providers
como ferramentas subordinadas. Nem o binário, nem seus PRDs, perfis, drivers ou
state dependem de `/goal`.
