# CRM V1.3.6.6 — Canonical Contact Identity

## Objetivo
Corrigir a reativação quando o mesmo WhatsApp existe em mais de um contato/conversa do Chatwoot, inclusive no caso brasileiro de celular legado armazenado com e sem o nono dígito.

## Caso validado em produção
- reativação enviada pela conversa `#303` / contato `120`;
- respostas recebidas pela conversa `#184` / contato `114`;
- os dois registros representam o mesmo número lógico, persistido em formatos diferentes;
- o matching anterior por `conversation_id` mantinha `Responderam = 0`.

## Implementação
- novo módulo `src/contact-identity.js`;
- normalização de telefone brasileiro em identidade canônica;
- celular legado de 8 dígitos com prefixo móvel 6–9 recebe o nono dígito apenas para comparação;
- telefone fixo não recebe nono dígito;
- `reactivation_recipients` passa a persistir `canonical_phone`;
- registros existentes recebem backfill automático no startup;
- proteção de reativação única passa a considerar conversa, contato ou telefone canônico;
- webhook `message_created` correlaciona incoming pela identidade do remetente, mesmo que `conversation_id` e `contact_id` sejam diferentes do envio;
- polling REST de fallback procura outras conversas da mesma identidade e registra a primeira incoming posterior a `sent_at`;
- auditoria preserva `reply_message_id`, `reply_conversation_id` e `reply_contact_id`;
- duplicatas da mesma identidade dentro da mesma campanha são bloqueadas;
- a resposta é atribuída somente à reativação enviada mais recentemente daquela identidade, evitando inflação de métricas em legado duplicado.

## Segurança / privacidade
- nenhum conteúdo de mensagem é persistido na auditoria;
- o webhook continua exigindo HMAC válido e janela anti-replay;
- o telefone canônico é usado somente como chave operacional interna da reativação;
- o patch não mescla nem apaga contatos do Chatwoot.

## Migração
Não há migration manual. O `db.js` usa `ensureColumn` durante o startup para acrescentar:

- `canonical_phone`;
- `reply_conversation_id`;
- `reply_contact_id`.

Depois das colunas, cria o índice `idx_reactivation_recipients_org_phone` e executa o backfill dos destinatários já existentes.

## Validação esperada do caso existente
Após deploy, abrir **Reativação** e clicar **Atualizar** deve permitir ao fallback localizar a resposta da conversa `#184` para a reativação originalmente enviada pela `#303`, resultando em:

```text
ENVIADOS      1
RESPONDERAM   1
TAXA          100%
```

Sem criar nova campanha e sem reenviar mensagem.
