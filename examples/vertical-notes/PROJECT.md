# Vertical Notes

Vertical Notes e um projeto pequeno usado somente para demonstrar o Ralph v2 de ponta a ponta.
Ele nao define defaults tecnologicos para o Ralph nem para a skill de PRD.

## Stack deliberadamente escolhida para este sample

- Node.js 22 ou superior, ES modules e apenas APIs built-in no runtime;
- HTML, CSS e JavaScript de navegador sem framework;
- persistencia local em `var/notes.json`, com escrita atomica;
- container OCI descrito por `Dockerfile` e configuracao local em `compose.yaml`;
- uma unica aplicacao HTTP serve a API e os arquivos estaticos.

## Resultado do produto

Uma pessoa abre a pagina, observa a saude do servico, cria uma nota curta e continua vendo essa nota
depois de recarregar a pagina ou reiniciar o processo. Falhas de validacao e persistencia aparecem
de forma util na interface e nos logs, sem expor o conteudo da nota nos logs operacionais.

O repositorio inicial contem apenas a especificacao, os PRDs e os fixtures de operacao do Ralph. O
executor deve criar a aplicacao nas slices; nao deve substituir a stack acima.
