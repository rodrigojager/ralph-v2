# Instruções para implementar o Ralph v2

## Leitura obrigatória

Antes de editar código:

1. Leia `README.md`.
2. Leia todos os arquivos de `docs/` na ordem numérica.
3. Leia `PRD.md` e o subplano de `implementation/` correspondente à tarefa atual.
4. Consulte o Ralph atual apenas como referência de comportamento. Não implemente a v2 dentro do checkout antigo e não altere esse checkout sem autorização explícita.

## Invariantes arquiteturais

- O CLI e sua máquina de estados são a autoridade. A IA nunca escolhe a tarefa oficial, muda política, persiste conclusão, inicia filho ou aprova a si mesma fora de um comando do Ralph.
- Providers, modelos e credenciais são ferramentas do CLI.
- Tool calling é permitido apenas dentro do conjunto de tools e permissões fornecido pelo comando atual.
- A camada de provider não pode acessar o estado do PRD, marcar tarefas, executar Git ou iniciar processos arbitrários.
- A camada de tools pode modificar o workspace quando autorizada, mas não pode alterar o estado oficial da tarefa.
- Somente a orquestração pode transicionar runs, tarefas, tentativas, avaliações e filhos.
- O executor do Ralph nunca gera ou expande PRDs ou sub-PRDs. A skill de geração de PRD é a única autora desses arquivos. O runtime apenas valida, lê, executa e atualiza marcadores permitidos.
- Cada chamada de tarefa começa com contexto controlado. Não existe dependência em memória conversacional oculta.
- A TUI é uma projeção do event bus e um cliente de comandos. Não contém regras de negócio exclusivas.
- Toda configuração disponível em popup deve possuir equivalente por CLI/config file; a TUI nunca pode ser o único caminho.
- O modo headless não é secundário. Ele deve ter os mesmos recursos e contratos do modo TUI.
- O PRD v2 é Markdown legível, com gramática estrutural determinística. Não use uma coleção de regexes sobre Markdown livre.
- O projeto alvo executado pelo Ralph pode usar qualquer linguagem, framework ou ferramenta. A skill e o schema de PRD não prescrevem stack.
- Não fabrique métricas. Tokens, custo, progresso e reasoning devem declarar `reported`, `estimated` ou `unavailable` quando aplicável.
- Não exiba chain-of-thought privada. Mostre apenas texto e summaries de reasoning explicitamente fornecidos pelo provider.

## Stack pretendida

- TypeScript em modo estrito.
- Bun como runtime, package manager, test runner e base de distribuição enquanto compatível com as plataformas alvo.
- SolidJS + OpenTUI para a TUI.
- Effect pode ser usado nas fronteiras derivadas do OpenCode e infraestrutura assíncrona, mas o domínio do Ralph deve permanecer compreensível e testável sem exigir que toda regra de negócio seja escrita em Effect.
- Armazenamento transacional local para runs e leases; a escolha final deve cumprir os contratos de crash recovery e concorrência descritos em `docs/10-*`.

## Estratégia de implementação

- Trabalhe pela ordem de `PRD.md`.
- Cada entrega deve ser uma vertical slice utilizável de ponta a ponta.
- Não implemente primeiro todos os providers, depois toda a TUI e só depois a orquestração. A primeira slice deve executar uma tarefa completa por um backend mínimo e produzir evidência observável.
- O binário, o pacote e o comando público são sempre `ralph`. Não crie nome temporário, alias de
  transição ou segundo comando público para a v2.
- Preserve fixtures e testes black-box do Ralph antigo como contrato de compatibilidade.
- Não copie o runner de sessão completo do OpenCode. Extraia providers, autenticação, catálogo, protocolos LLM, normalização de eventos, tools ou componentes de TUI somente quando forem necessários e desacople-os dos conceitos de sessão/servidor do OpenCode.
- Todo arquivo derivado do OpenCode deve ter origem, commit e licença documentados.

## Regras de alteração

- Atualize o documento normativo correspondente quando uma decisão de contrato mudar.
- Não duplique schemas manualmente sem teste de paridade. O parser, o JSON Schema/validador, os exemplos e a skill devem derivar de uma única fonte ou possuir teste que impeça divergência.
- Não persista segredos em PRD, logs, eventos ou config de workspace.
- Faça redaction antes de persistir output potencialmente sensível.
- Não use `completed` como sinônimo de “o modelo disse que terminou”. Conclusão exige as políticas de evidência e avaliação configuradas.
- Diferencie retries de provider, retries de schema do judge, revisões de código, restarts do watchdog e tentativas de no-change.
- Operações destrutivas de Git, limpeza ou rollback exigem política explícita e alvo validado.

## Verificação mínima por slice

- Testes unitários das regras alteradas.
- Teste de integração atravessando as camadas tocadas.
- Smoke do comando público relevante.
- Evidência de que o modo headless continua funcionando.
- Quando houver TUI, teste do event store/view model e smoke em terminal real ou harness PTY.
- Teste de retomada quando a slice altera persistência, workers, tool calls ou finalização.
- Teste em Windows para qualquer mudança de processo, caminho, shell, OAuth callback, terminal ou filesystem.

### Execução sem roubar foco no Windows

- Automação deve iniciar Bun, testes, builds, smokes e outros processos headless com janela oculta
  (`Start-Process -WindowStyle Hidden` ou API equivalente), redirecionar stdout/stderr para arquivos
  e ler os logs depois; para execuções longas, preferir prioridade `BelowNormal`.
- No PowerShell 7+, preferir `scripts/run-bun-hidden.ps1` para o processo Bun de topo; ele preserva
  argumentos sem shell, cria logs únicos no diretório temporário e retorna o mesmo exit code.
- Todo `Bun.spawn` interno deve declarar `windowsHide` explicitamente. Usar `true` para subprocessos
  headless e `false` somente quando uma ação interativa/GUI solicitada pelo usuário realmente precisa
  aparecer.
- Não interpretar silêncio de stdout redirecionado como travamento; observar processo, heartbeat,
  progresso, deadline e logs antes de cancelar.
- Uma TUI, editor ou popup pedido para uso humano é exceção intencional e não deve ser ocultado.

## Condição de conclusão do projeto

O projeto só pode substituir o binário `ralph` quando:

- todos os itens do `PRD.md` e subplanos estiverem concluídos;
- a matriz de compatibilidade obrigatória estiver verde;
- providers embutidos e backend CLI externo tiverem smoke real;
- ChatGPT OAuth e pelo menos um provider por API key tiverem fluxo validado;
- retomada, watchdog, judge, sub-PRDs e concorrência tiverem testes de falha;
- TUI e headless exibirem o mesmo estado sem divergência;
- pacotes de Windows, Linux e macOS tiverem sido construídos e testados;
- atribuições e licenças de terceiros estiverem completas.
