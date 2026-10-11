# Conferencia de categorias - 2026-09-16

Escopo: melhorar a correcao semantica na copia local; sem publicacao, sem
migracao e sem recalcular a rodada aberta pelo usuario.

## Falha observada

A rodada S exibiu oito aprovacoes com o motivo "Comeca com S", incluindo
silhueta em PCH. O resumo local registrou oito candidatos, zero fallback e
2.529 segundos na etapa de validacao. A chamada respondeu, mas isso nao
demonstrou que os vereditos estavam corretos. Publicar o mesmo codigo nao
corrigiria essa falha automaticamente.

## Mudancas

- Conferencia separada e obrigatoria de categoria: fits, does_not_fit ou
  uncertain, consistente com o veredito e acompanhada de justificativa.
- Definicoes explicitas das oito categorias; PCH distingue estruturas
  anatomicas de aparencia geral, roupas, objetos, contorno e sombra.
- Tolerancia a acentos e erros simples de escrita, incluindo trocas foneticas.
- Segunda conferencia somente dos itens rejeitados, duvidosos ou com
  explicacao generica/contraditoria. A primeira chamada usa esforco medium;
  a segunda usa high, compartilhando o prazo original de 20 segundos.
- Uma segunda explicacao ainda insuficiente permanece needs_review (5),
  com ajuste opcional do anfitriao. Respostas boas nao sao substituidas.
- Desconhecimento declarado nao e prova de erro. Rejeicoes com motivos de
  falta de reconhecimento ficam provisoriamente pendentes de conferencia.
- Saida malformada da IA nao recebe automaticamente os 10 pontos do modo
  escolar. Falha de transporte em todas as tentativas mantem a politica
  escolar preexistente, com indicacao explicita na justificativa.
- A busca publica existente agora identifica o aplicativo no User-Agent e
  registra falhas por classe/status, sem nomes ou respostas nos logs.

Nao foi criada lista de palavras proibidas para silhueta ou de excecoes
para os exemplos. A memoria de ajustes do anfitriao continua prioritaria.

## Evidencia obtida

1. Primeira amostra com Groq real, 33 itens: 30 dentro dos criterios.
   Silhueta foi rejeitada corretamente, mas Pescosso e Camela receberam
   rejeicoes inadequadas; Sol Nascente ficou incerto.
2. Depois de reforcar a segunda conferencia: 32/33 nos criterios estritos
   do provedor isolado. Pescosso foi entendido como pescoco, Peaple como
   people, Pernanbuco como Pernambuco e Preucurando Nemo como o titulo
   pretendido. Camela ficou com 5 (duvida), sem rejeicao por desconhecimento.
   Sol Nascente ainda precisou de fonte externa. Nao ocultar esse resultado:
   `tests/evaluate-groq.mjs --live` e uma avaliacao exigente do modelo isolado,
   nao um teste da busca complementar, e pode sair com codigo 1.
3. Fluxo completo em sala local sintetica separada, com Worker, D1, Groq e
   busca publica: primeira tentativa ficou em 65, pois a consulta externa
   nao confirmou o titulo. Depois do ajuste de identificacao da consulta,
   nova tentativa terminou em **70 pontos**, em **10,740 segundos incluindo
   a tolerancia de encerramento**. Sol Nascente teve justificativa
   "Confirmada em fonte publica". Nao ha evidencia suficiente para atribuir
   retrospectivamente a falha anterior a um status HTTP especifico.
4. As oito respostas persistidas permaneceram iguais aos textos enviados.
   As salas sinteticas foram excluidas ao final; a rodada do usuario nao
   foi alterada. Proximas rodadas usam a nova conferencia.
5. 39 testes automatizados passaram: regras anteriores, isolamento,
   transporte, formato, segunda conferencia seletiva, motivo generico,
   inconsistencias, prazos, preservacao de respostas boas, correcao de
   grafia e confirmacao externa no caminho real das rotas (provedor simulado).

## Resultado da rodada sintetica S

| Categoria | Resposta | Pontos |
| --- | --- | ---: |
| Nome | Sabrina | 10 |
| Lugar | Siria | 10 |
| Objeto | Sapato | 10 |
| MSE | Sensata | 10 |
| PCH | silhueta | 0 |
| Palavra em Ingles | seal | 10 |
| Multimidia | Sol nascente | 10 |
| Comida | salada | 10 |
| Total | | 70 |

## Limites

Essa amostra pequena nao mede precisao geral nem garante que o modelo
sempre repetira os mesmos vereditos. A classificacao e a justificativa ainda
podem conter erros; a segunda conferencia usa o mesmo provedor, nao um
arbitro independente. A busca publica pode ficar indisponivel e a heuristica
de correspondencia textual ainda tem limites. Ajuste manual continua util.

Mais chamadas aumentam custo e duracao, limitados pelo prazo compartilhado;
nao houve teste com 40 jogadores. Permanecem os riscos de infraestrutura
e dependencias registrados na auditoria de 15/09. Nenhum novo score global
foi calculado neste trabalho.

Referencias de implementacao: [Groq Structured Outputs](https://console.groq.com/docs/structured-outputs),
[Groq API](https://console.groq.com/docs/api-reference),
[MediaWiki API etiquette](https://www.mediawiki.org/wiki/API:Etiquette).
Formato JSON correto garante estrutura, nao veracidade semantica.
