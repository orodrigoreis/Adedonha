# Adedonha/Stop!

Jogo online com salas, categorias, cronômetro de quatro minutos, correção
automática e pódio. O anfitrião controla a rodada e pode ajustar as notas.

## Autopreenchimento do anfitrião

Depois de **Começar rodada**, cada anfitrião tem o botão
**Autopreencher respostas**. Ele preenche apenas os próprios campos vazios com
sugestões da letra atual, salva as respostas e permite editá-las antes do fim.
Respostas já digitadas, inclusive durante a busca, são preservadas.

Participantes não veem o botão e o servidor recusa suas requisições de
autopreenchimento. Sugestões de rodadas antigas ou encerradas são descartadas.

As oito categorias padrão têm exemplos locais para as letras do alfabeto.
Combinações sem exemplo, como PCH com K, W ou Y, podem ser completadas pela
Groq quando a credencial estiver configurada. Sem uma sugestão disponível,
o campo fica vazio e a tela informa a categoria. Sugestões passam pela mesma
correção e pontuação das respostas digitadas.

## Desenvolvimento

Requisitos: Node.js 24 ou superior e npm. Use o checkout existente; cada tarefa
na nuvem já tem um ambiente isolado e não precisa de um Git worktree.

```sh
npm ci
npm run db:migrate
npm run dev
```

O servidor usa a porta 3001. O banco D1 é local e fica em `.wrangler/state/`.
As migrações são reaplicáveis e não precisam de uma conta Cloudflare.
O identificador zerado de `wrangler.jsonc` é exclusivo para desenvolvimento
local; configure o banco real antes de qualquer publicação.

Na máquina da nuvem, use um diretório de configuração gravável para o Wrangler:

```sh
export XDG_CONFIG_HOME=/tmp/adedonha-config
export WRANGLER_SEND_METRICS=false
export npm_config_cache=/tmp/adedonha-npm-cache
```

Para habilitar a IA localmente, configure `GROQ_API_KEY` em um arquivo
`.dev.vars` ignorado pelo Git. Na hospedagem, use um segredo do Worker.
Nenhuma chave deve ser enviada ao GitHub. A correção mantém o modo escolar
de reserva quando a IA está indisponível.

## Verificação

```sh
npm test
npm run typecheck
npm run build
```

Com o servidor de desenvolvimento aberto, `npm run test:browser` verifica o
botão em duas salas, a permissão do anfitrião, a preservação de respostas,
o salvamento no D1 e a tela de celular. Usa Chromium instalado no sistema
ou o navegador do Playwright (`npx playwright install chromium`).
`CHROMIUM_PATH` pode apontar para outro executável de Chromium.

## Recuperação do projeto

O código foi recuperado da conversa compartilhada porque o repositório
original continha somente este README. Configuração de ferramentas e
lockfile foram reconstruídos e validados. Consulte
[o registro da recuperação](docs/recuperacao.md) e os relatórios históricos
em `docs/`.

Enviar alterações ao GitHub guarda o código e seu histórico. Atualizar o site
publicado é uma operação separada; este repositório não publica automaticamente.
