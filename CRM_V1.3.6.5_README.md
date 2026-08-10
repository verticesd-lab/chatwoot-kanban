# CRM V1.3.6.5 — Webhook Reply Tracking

## Objetivo
Contabilizar respostas de clientes às campanhas de reativação usando o evento `message_created` do Chatwoot como fonte primária, em vez de depender apenas da paginação do endpoint REST de mensagens.

## Motivação
Em produção foi validado um caso em que a mensagem incoming aparecia na interface do Chatwoot, mas o endpoint `GET /conversations/:id/messages`, inclusive com `after=<message_id>`, não a retornava naquele momento. Por isso o polling REST não é suficiente como única fonte de verdade para a métrica `Responderam`.

## Implementação
- novo endpoint público assinado: `POST /api/integrations/chatwoot/reactivation-webhook`;
- aceita apenas `message_created` público e incoming;
- valida `X-Chatwoot-Signature` com HMAC-SHA256 do corpo bruto;
- valida `X-Chatwoot-Timestamp` com janela anti-replay configurável;
- resolve a organização pelo `account.id` do webhook;
- marca resposta somente quando a mensagem incoming é posterior ao `sent_at` da reativação;
- persiste `reply_message_id` para auditoria;
- processamento é idempotente: webhook duplicado não contabiliza duas respostas;
- mantém o polling existente como fallback, sem removê-lo.

## Variáveis
```env
REACTIVATION_CHATWOOT_WEBHOOK_SECRET=<secret do webhook no Chatwoot>
REACTIVATION_WEBHOOK_MAX_SKEW_SECONDS=300
```

Não reutilize o token da API do Chatwoot como segredo do webhook.

## Configuração do Chatwoot
Crie/edite um webhook da conta apontando para:

`https://<dominio-do-crm>/api/integrations/chatwoot/reactivation-webhook`

Assine o evento:

`message_created`

Copie o segredo gerado pelo Chatwoot para `REACTIVATION_CHATWOOT_WEBHOOK_SECRET` no Coolify e faça redeploy.

## Segurança
- HTTPS obrigatório em produção;
- assinatura HMAC verificada com comparação em tempo constante;
- timestamp antigo/replay é rejeitado;
- conteúdo da mensagem não é gravado no audit da reativação;
- apenas IDs/timestamp/delivery id são usados na auditoria.
