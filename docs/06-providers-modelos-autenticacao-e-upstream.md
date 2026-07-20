# 06 — Providers, modelos, autenticação e código upstream

## Objetivo

O Ralph v2 deve oferecer a variedade de providers e modelos que motivou a aproximação com o OpenCode, mas sem transformar o OpenCode em orquestrador. O Ralph conserva sua máquina de estados, suas políticas e seus comandos; o código selecionado do OpenCode é incorporado como infraestrutura interna e adaptado atrás de contratos próprios.

Executor e judge são clientes independentes dessa infraestrutura. Cada papel pode usar provider, modelo, credencial, limites e fallback diferentes.

## Separação obrigatória de responsabilidades

| Componente | Responsabilidade | Não pode fazer |
| --- | --- | --- |
| `ProviderDriver` | Descobrir modelos, montar request, invocar API e normalizar stream | Escolher tarefa, autorizar tool, alterar status |
| `CredentialDriver` | Listar métodos de login, conectar, renovar, resolver e revogar credenciais | Expor segredo em config/log ou escolher modelo |
| `ModelCatalog` | Informar capabilities, limites de contexto, variantes e metadados de custo | Autenticar ou invocar modelo |
| `ModelRouter` | Aplicar perfil explícito, compatibilidade e fallback permitido | Trocar silenciosamente de provider fora da política |
| `RoleProfile` | Vincular executor ou judge a driver/modelo/credencial/parâmetros | Compartilhar credencial por inferência |
| `Ralph orchestrator` | Decidir quando e por que invocar cada papel | Entregar sua autoridade ao driver |

Uma integração que só funciona importando o session runner, servidor, banco ou agente completo do OpenCode está fora do desenho. Ela deve ser refatorada até caber nesses ports ou descartada.

## Perfis independentes

Configuração mínima por papel:

```yaml
profiles:
  executor:
    provider: openai
    model: codex-model-id
    credential: chatgpt-main
    variant: balanced
    max_output_tokens: 16000
    fallback: [executor-backup]
  judge:
    enabled: true
    provider: openrouter
    model: judge-model-id
    credential: openrouter-judge
    temperature: 0
    fallback: []
```

Regras:

- `executor` e `judge` nunca herdam credencial um do outro por simples coincidência de provider;
- a UI pode oferecer “copiar perfil” como ação explícita, registrando o resultado completo;
- falha no judge não autoriza substituir o judge pelo executor, salvo fallback explicitamente configurado;
- o judge deve preferencialmente ser um modelo/provedor diferente, mas isso é recomendação de configuração, não obrigação do produto;
- um child run pode herdar nomes de perfis do pai, mas resolve sua própria cópia imutável no início da tentativa;
- mudanças de default só afetam tentativas futuras, nunca uma tentativa já registrada.

## Métodos de autenticação

O catálogo de cada provider declara os métodos realmente suportados:

1. `api-key`: segredo informado no popup ou comando seguro;
2. `environment`: referência ao nome de variável, sem copiar seu valor para o arquivo de configuração;
3. `oauth-browser`: fluxo com PKCE, callback local ou código retornado pelo provider;
4. `device-code`: quando o provider oferecer protocolo de dispositivo;
5. `subscription-session`: tokens de conta/assinatura obtidos por fluxo oficial suportado;
6. `existing-session`: importação opt-in de uma sessão compatível, somente se houver contrato estável e consentimento explícito;
7. `external-cli`: uso de um executável já autenticado como backend de compatibilidade, separado do driver embutido.

O Ralph não deve prometer OAuth para um provider que só oferece API key. A UI mostra apenas os métodos anunciados pelo driver e explica se o método consome assinatura, créditos de API ou uma conta externa.

### Backend external CLI

O backend `external-cli` é um processo subordinado, não um passe livre para um
agente controlar Ralph. O perfil fixa executável, argumentos ordenados, cwd
relativo ao workspace, referências `env:<NAME>`, protocolo de stdin, adapter,
capabilities, mutation mode, timeout e limite de output. `protocol` usa o
envelope Ralph; `known-output` exige um adapter ID explícito; `generic` captura
uma resposta limitada sem inventar capabilities. Tool calling declara
separadamente `ralph`, `internal` ou `unavailable`, de modo que o supervisor não
confunda eventos reportados pelo processo com tool calls autorizadas e
liquidadas pelo Ralph.

Segredos nunca entram em `args` ou no arquivo. O processo recebe somente as
variáveis cujas origens foram referenciadas no perfil e resolvidas pela
composição segura no momento da execução.

### ChatGPT Plus/Pro para Codex/OpenAI

O requisito é usar a conta ChatGPT elegível, e não meramente executar `codex` como subprocesso. O driver embutido deve suportar o fluxo de conexão de conta compatível com a implementação upstream selecionada:

- abrir autorização no navegador;
- receber callback ou código com proteção de estado/PKCE;
- persistir somente tokens/refs necessários no secret store;
- renovar sessão dentro dos termos do fluxo;
- apresentar conta e expiração sem imprimir tokens;
- permitir desconectar/revogar;
- distinguir claramente esta credencial de uma `OPENAI_API_KEY`;
- falhar com orientação acionável quando a conta, região ou modelo não forem elegíveis.

Se o upstream alterar esse fluxo, o Ralph deve falhar fechado e solicitar atualização do driver. Não deve recorrer silenciosamente a uma API key nem invocar o Codex CLI sem configuração.

## Armazenamento de credenciais

Ordem preferencial:

1. keychain/credential manager do sistema operacional;
2. provider de segredo configurado pelo usuário;
3. arquivo local criptografado com chave protegida pelo sistema;
4. variável de ambiente referenciada;
5. arquivo texto apenas em modo explicitamente inseguro, com aviso bloqueante e permissões restritas.

O config persistido contém `CredentialRef`, nunca o segredo. Logs, eventos, relatórios, crash dumps e output bruto passam por redaction baseada em nomes conhecidos, valores resolvidos e padrões de header. A resolução do segredo acontece no worker imediatamente antes da chamada e o valor não cruza o event bus.

## Descoberta e seleção de modelos

Cada `ModelInfo` deve declarar, quando conhecido:

- identificador estável e nome de exibição;
- provider e família;
- entrada de texto/imagem/arquivo;
- tool calling e tool streaming;
- reasoning e variantes suportadas;
- structured output/JSON schema;
- tamanho de contexto e limite de saída;
- métricas de usage disponíveis;
- preços/metadados de custo, com timestamp e origem;
- disponibilidade para assinatura versus API;
- estado `available`, `unavailable`, `unknown` ou `deprecated`.

O seletor TUI filtra por capabilities requeridas pelo papel. O CLI rejeita antecipadamente combinações incompatíveis, por exemplo judge sem structured output quando o perfil exige JSON schema estrito, a menos que exista adaptador de extração explicitamente habilitado.

Catálogo remoto é cacheado com TTL e snapshot local. Uma execução registra o snapshot/model ID utilizado para ser reproduzível. Preço e availability são informativos; uma indisponibilidade dinâmica ainda pode ocorrer.

## Variantes e parâmetros

Variantes como esforço de reasoning, velocidade ou qualidade são metadados do driver e não nomes mágicos globais. O perfil aceita parâmetros comuns tipados e um bloco provider-specific validado pelo driver. Parâmetros desconhecidos geram erro, não são descartados silenciosamente.

Temperatura, top-p e reasoning só são enviados se o modelo suportar. O Ralph pode fornecer presets `fast`, `balanced` e `thorough`, mas cada preset expande para configuração visível e editável; ele nunca muda a semântica de gates ou completion.

## Fallback

Fallback é uma lista ordenada e explícita de perfis completos. Ele só ocorre para classes configuradas, como indisponibilidade, rate limit ou falha transitória. Não ocorre para:

- autenticação inválida;
- recusa de permissão de tool;
- falha determinística de gate;
- resposta do judge reprovando o conteúdo;
- erro de configuração/schema;
- limite de custo/tokens atingido.

Cada troca gera evento e aparece no relatório. A tentativa registra qual modelo realizou cada etapa. Se trocar de executor no meio de uma task, o novo call recebe contexto reconstruído pelo Ralph, nunca estado oculto do driver anterior.

## Backend embutido e backend CLI

O backend embutido é o caminho principal: driver TypeScript, streaming estruturado, usage e tool calls normalizados. O backend CLI externo continua como compatibilidade para agentes como `codex`, `claude`, `opencode` ou comandos customizados, quando o usuário quiser. Ele deve:

- receber prompt/contexto por contrato conhecido;
- ter timeout, cancelamento, cwd e environment controlados;
- usar adaptador de output versionado;
- declarar se fornece usage/tool events ou apenas texto;
- nunca ser confundido com autenticação embutida de conta;
- preservar stdout/stderr bruto para diagnóstico.

## Curadoria do código do OpenCode

O snapshot efetivamente curado está fixado no commit
`45cd8d76920839e4a7b6b931c4e26b52e1495636`. A autoridade determinística está em
`third_party/opencode/PROVENANCE.json`, e `UPSTREAM.md`, `copied-files.md` e `patches.md` mantêm a
projeção humana da mesma origem, hashes e adaptações. Todo refresh precisa atualizar e revalidar os
dois formatos no mesmo change set.

### Candidatos a adaptação

- registro e metadata de providers;
- fluxos de autenticação oficiais suportados;
- resolução de modelos e capabilities;
- transformação de requests/responses por provider;
- normalização de eventos de texto, reasoning, tool call/result/error e finish;
- cálculo de usage e custo quando presente;
- primitives e patterns selecionados de OpenTUI/Solid para popups e painéis.

### Não transplantar como núcleo

- loop completo de agente/sessão do OpenCode;
- seleção de tarefa, permissionamento ou conclusão do OpenCode;
- banco/servidor da aplicação quando não necessário ao port;
- comandos, branding, logo ou identidade de produto;
- dependências privadas do monorepo sem extração e testes próprios;
- tipos upstream como schema público/persistido do Ralph.

### Procedimento obrigatório de cópia

1. Fixar commit e licença.
2. Listar arquivos originais e destinos em `copied-files.md`.
3. Preservar headers e avisos exigidos.
4. Documentar alterações substanciais em `patches.md`.
5. Colocar adaptação atrás de um port do Ralph.
6. Adicionar teste de contrato e fixture de stream.
7. Atualizar `THIRD_PARTY_NOTICES.md`.
8. Verificar dependências e licenças transitivas.
9. Proibir update automático de código upstream.

Uma atualização futura é um processo de vendor refresh: comparar commits, revisar changelog/diff, reaplicar patches, rodar matriz de providers e gerar registro de proveniência.

## Critérios de aceite

- Executor e judge podem ser configurados com providers/modelos/credenciais diferentes.
- API key e pelo menos um fluxo de conta/assinatura funcionam end to end sem gravar segredo em texto.
- ChatGPT Plus/Pro, quando suportado pelo upstream fixado, usa login embutido e não depende do executável `codex`.
- Backend CLI externo permanece possível e claramente identificado.
- Capabilities incompatíveis são rejeitadas antes de iniciar trabalho.
- Fallback nunca mascara falha determinística ou configuração inválida.
- Cada arquivo derivado possui origem, licença, commit e testes registrados.
