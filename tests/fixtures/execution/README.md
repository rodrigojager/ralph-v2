# Fixtures executáveis da S03

Cada diretório é um workspace mínimo e independente. `PRD.md` é o único plano autoritativo;
os arquivos `backend*.json` são filas de `ScriptedExecution` destinadas exclusivamente à
composition root de teste. O binário normal não registra o backend `fake`.

| Fixture | Modo principal | Script | Resultado esperado |
| --- | --- | --- | --- |
| `single-pass` | `once` | `backend.json` | altera o entregável, passa o command gate e conclui |
| `two-task-order` | `loop` | `backend.json` | executa duas tasks na ordem imposta pela dependência |
| `blocking-gate-failure` | `once` | `backend.json` | produz diff, mas o gate bloqueante falha |
| `no-change-change-only` | `once` | `backend.json` | gate passa, porém `change-only` recusa delta vazio |
| `wiggum` | `wiggum` | `backend-converges.json` | converge na segunda iteração |
| `wiggum` | `wiggum` | `backend-exhausts.json` | esgota duas iterações sem mudança |
| `adversarial-task-complete` | `once` | `backend.json` | output contém `TASK_COMPLETE`, mas não há evidência |

Todos os commands usam argv estruturado, `shell: false`, cwd relativo, timeout e limite de
output. Categoria, blocking e skip policy são declarados no wrapper de cada verification. Os
PRDs não possuem Sub-PRDs porque execução de children pertence à S09.
