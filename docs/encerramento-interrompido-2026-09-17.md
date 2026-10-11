# Encerramento interrompido: investigacao de 2026-09-17

## Evidencia de producao

- Publicacao observada: versao 20, sem alteracoes durante a investigacao.
- Sala 3QGJB, letra D: encerramento registrado por volta de 14:17:05 e resultado
  registrado as 14:22:19 (America/Sao_Paulo).
- Os registros mostram um GET da sala cancelado proximo ao encerramento.
  Isso e compativel com a interrupcao do processamento; nao identifica por si
  so o motivo da desconexao nem comprova qual dispositivo a originou.
- A sala terminou em `review`, com 56 respostas de 7 jogadores, todas com
  status e motivo de validacao. Nenhuma estava marcada como modo reserva.
- O usuario confirmou que o resultado apareceu e a correcao estava correta.

O codigo publicado executa o encerramento dentro da requisicao HTTP, sem
registrar a tarefa para sobreviver ao desligamento do cliente. Depois de
marcar a sala como `closing`, espera os ultimos salvamentos e chama a IA.
Uma interrupcao pode deixar a sala nesse estado. A recuperacao so tenta
novamente quando outra consulta encontra a tentativa parada ha cinco minutos.
Esse mecanismo explica a demora observada, sem exigir uma falha da Groq.

## Correcao local

1. Registrar a promessa de encerramento com `after()` antes da primeira
   escrita. A requisicao continua aguardando o resultado normalmente, mas
   a mesma tarefa passa a ter protecao de ciclo de vida contra desconexao.
2. Reduzir de cinco minutos para um minuto a elegibilidade de recuperacao
   de uma tentativa interrompida. Uma consulta autenticada ainda e necessaria
   para disparar essa recuperacao; nao existe fila duravel ou alarme autonomo.
3. Conferir a identificacao da rodada e o instante da tentativa em todas as
   escritas do encerramento. Uma tentativa antiga nao pode preencher respostas,
   sobrescrever pontuacoes ou concluir a tentativa mais recente.
4. Limitar o trabalho externo ao menor prazo entre 20 segundos de validacao
   e 25 segundos desde o inicio do encerramento. Consultas publicas respeitam
   o tempo restante. O tempo final de banco de dados nao tem garantia rigida.
5. Registrar `round_closing_recovery` sem textos das respostas ou credenciais.

Nenhuma regra de pontuacao foi alterada nesta correcao. A politica escolar de
reserva ja existente continua sendo usada se o tempo externo se esgotar.
Nao foi adicionada migracao por este ajuste; a migracao 0005 de trabalhos
anteriores continua pendente para a futura publicacao do conjunto local.

## Verificacao

- 44 testes passaram, incluindo cinco novos testes de ciclo de encerramento.
- TypeScript, ESLint e compilacao de producao passaram.
- `tests/local-disconnect-smoke.mjs` passou contra o Worker e o D1 locais:
  uma sala sintetica foi criada, a conexao de encerramento foi abortada em
  `closing`, e nenhuma consulta foi feita durante os 6,5 segundos seguintes.
  A consulta final encontrou `review`, mantendo a resposta intacta.
- Tempo ate a observacao: 6.720 ms, incluindo a espera artificial do teste;
  nao representa uma medida exata da duracao da correcao.
- O teste usou uma inicial incorreta para dispensar chamadas de IA. Somente
  a sala sintetica criada pelo proprio teste foi removida ao terminar.

## Limites e publicacao

O teste local nao substitui a verificacao depois de publicar. Nao foram
testadas todas as falhas de infraestrutura nem uma turma de 40 jogadores.
A protecao de tempo de vida nao e uma fila duravel e nao cobre uma parada
completa da plataforma. A recuperacao com trava permanece necessaria.

Referencias primarias consultadas:
- [Next.js after](https://nextjs.org/docs/app/api-reference/functions/after)
- [Cloudflare ExecutionContext / waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/)

A implementacao instalada de Vinext tambem foi inspecionada: `after(promise)`
registra a promessa no `waitUntil` do contexto da requisicao. A plataforma
documenta ate 30 segundos adicionais apos resposta ou desconexao, nao uma
garantia de execucao ilimitada.

Nenhuma versao foi salva ou publicada. Nenhuma resposta real foi alterada.
Publicacao depende de autorizacao do usuario.
