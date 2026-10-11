# Recuperação da Adedonha

O checkout recebido na nuvem tinha apenas o README do commit inicial.
As alterações de código foram recuperadas em ordem a partir desta conversa
compartilhada pelo proprietário:

https://chatgpt.com/s/cx_6ac4de265fcc819198b1dc7212063f09

Foram recuperados os componentes da aplicação, rotas, regras de validação,
migrações D1, testes e relatórios. O histórico de commits da pasta Windows
original não estava disponível; este repositório começa um novo histórico
versionado para os arquivos recuperados.

O snapshot não continha o conteúdo completo das configurações iniciais.
`package.json`, `tsconfig.json`, Vite, Worker, Wrangler e regras de exclusão
foram reconstruídos. As versões de Next, React, Vite e Vinext registradas na
conversa foram mantidas. O Wrangler foi alinhado à versão usada pelo plugin
Cloudflare para que ambos usem o mesmo runtime e formato do banco local.
O novo lockfile permite `npm ci`.

A substituição global de `env.DB` por `db`, ausente dos diffs, foi recuperada
das declarações e dos contextos posteriores. Quatro expressões de código
redigidas pelo compartilhamento foram reconstituídas: a comparação com
`member.auth_token_hash`, duas URLs locais de teste e `AbortSignal.timeout`.

Valores de credenciais, `.env.local`, metadados de publicação, caches,
arquivos gerados e conteúdo do banco de produção não foram copiados.
O site existente continua sendo uma publicação independente.

Antes do autopreenchimento, os 49 testes recuperados passaram. A nova função
acrescenta testes de autorização, isolamento de salas, preenchimento dos
campos vazios e descarte de sugestões quando a rodada muda. O teste de
navegador usa o Worker e o banco D1 reais, ambos locais.
