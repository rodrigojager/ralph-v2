# Goldens redigidos da integração local

Os JSON deste diretório são goldens executáveis comparados por igualdade estrutural em
`tests/integration/s12-sample-e2e.test.ts`. Eles registram a projeção determinística observada depois
que o teste local validou o ledger, as tentativas, os assessments, os evidence bundles, os artifacts,
o parent/child, o crash/resume, a view da TUI e a aplicação HTTP entregue.

Esses arquivos são projeções redigidas, não cópias dos schemas autoritativos de report/evidence. IDs
de run/attempt, hashes reais, timestamps, path externo do judge, texto da nota, tokens e credenciais
não entram nos goldens. O valor `redacted-after-runtime-validation` declara que o hash real foi
validado antes da projeção; ele não é um hash fabricado nem um receipt de release.

`executed-local-integration` significa somente que o teste focado passou neste checkout com 1/1 teste
e 59 asserções. A execução usou um executor roteirizado e um judge fake determinístico em processo
external-CLI supervisionado. Ela não chamou provider/modelo/conta real, não abriu uma TUI interativa
em PTY e não executou um artifact instalado ou candidato a release. Portanto, estes goldens não são
uma alegação de suporte de provider, plataforma ou distribuição.

Para um run operacional, consulte os records autoritativos concretos:

```text
ralph-next status run --run-id <RUN_ID> --format json
ralph-next events --run-id <RUN_ID> --format jsonl
ralph-next report show <RUN_ID> --format json
```

Nunca copie valores destes goldens para preencher campos runtime ou evidence de promoção. Uma prova
de release precisa continuar vinculada ao commit, artifact, target, ambiente e run exatos.
