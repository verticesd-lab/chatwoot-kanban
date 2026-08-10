# AutoCredit CRM V1.3.6.4 — Reactivation Reply Sync Hotfix

## Objetivo

Corrigir a contabilização de respostas após uma reativação enviada.

## Causa

A sincronização de respostas consultava a coleção de conversas do Chatwoot e tentava inferir a resposta a partir do objeto resumido da conversa. Esse endpoint é adequado para listagem, etiquetas e atividade, mas não é uma fonte confiável do thread de mensagens necessário para provar uma resposta posterior ao envio.

## Correção

Para cada destinatário com reativação em estado `sent` e ainda sem `replied_at`, o CRM consulta diretamente:

`GET /api/v1/accounts/:account_id/conversations/:conversation_id/messages`

A resposta só é contabilizada quando existe uma mensagem `incoming` com timestamp posterior ao `sent_at` da reativação.

## Segurança e comportamento

- não altera a regra de reativação única;
- não remove nem reaplica etiquetas;
- não dispara mensagens;
- não cria nova campanha;
- falhas de leitura do Chatwoot são registradas como `reactivation.reply_sync.failed` e não inventam resposta;
- o histórico/summary continua usando `replied_at` persistido no SQLite.

## Validação

- `npm run check`
- `npm test`
- regressão para `messages[]` com `message_type = 0` (incoming)
- contrato estático garantindo uso do endpoint de mensagens no reply sync
