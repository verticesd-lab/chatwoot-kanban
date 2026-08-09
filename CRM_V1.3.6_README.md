# CRM V1.3.6 — Reativação Manual Controlada

A V1.3.6 adiciona ao CRM comercial uma central de reativação manual de leads, mantendo o Chatwoot como canal de envio e preservando a regra de contato único.

## Objetivo

Recuperar oportunidades paradas por seleção humana, sem criar follow-up infinito ou automação insistente.

Etiquetas elegíveis padrão:

- `aguardando-cpf-de-terceiros`
- `fora-do-horario`
- `aguardando-retorno-do-cliente`

Etiqueta de proteção padrão:

- `reativacao-unica-enviada`

Os nomes podem ser ajustados por variáveis de ambiente sem alteração de código.

## Fluxo

1. O operador abre **Reativação**.
2. Filtra período e etiquetas.
3. Seleciona leads elegíveis ou inclui manualmente uma conversa existente.
4. Escolhe/edita um template.
5. Revisa a prévia obrigatória.
6. O servidor revalida cada conversa.
7. Cada destinatário entra em uma fila persistente SQLite.
8. O worker interno envia uma mensagem por ciclo.
9. Após confirmação do Chatwoot, o CRM registra o envio e aplica a etiqueta de proteção.
10. O histórico mostra enviados, bloqueados, falhas e respostas detectadas.

## Segurança operacional

- `REACTIVATION_SEND_ENABLED=false` por padrão.
- Limite padrão de 100 destinatários por campanha.
- Inclusão manual ignora somente a falta de etiqueta elegível; nunca ignora a proteção de reativação única.
- Conversas ganhas/perdidas são bloqueadas.
- Uma conversa já enviada, em fila, em processamento ou com resultado incerto não entra novamente.
- Se o processo cair durante um envio, o destinatário fica como `uncertain`; ele **não é reenfileirado automaticamente**, evitando duplicidade.
- O envio é persistente e assíncrono; a requisição HTTP da tela não tenta disparar o lote inteiro.
- Cancelar campanha cancela somente itens ainda em fila.

## Templates

A única variável suportada nesta versão é:

```text
{{primeiro_nome}}
```

Templates incluídos:

- Retomada geral
- CPF de terceiros
- Fora do horário
- Aguardando retorno

## Permissões

Podem operar a central:

- administrador;
- gerente;
- SDR.

O usuário também precisa possuir `messages:send` para confirmar campanha.

## Variáveis

```env
REACTIVATION_SEND_ENABLED=false
REACTIVATION_ELIGIBLE_LABELS=aguardando-cpf-de-terceiros,fora-do-horario,aguardando-retorno-do-cliente
REACTIVATION_BLOCK_LABEL=reativacao-unica-enviada
REACTIVATION_MAX_RECIPIENTS=100
REACTIVATION_WORKER_INTERVAL_MS=3000
```

## Primeiro deploy

Mantenha `REACTIVATION_SEND_ENABLED=false`. Valide login, menu, candidatos, filtros, inclusão manual, templates, prévia e histórico. Confirme também no Chatwoot os nomes reais das quatro etiquetas. Só então ative o envio e redeploy.

## Observabilidade

A V1 registra em `audit_logs`:

- `reactivation.campaign.created`
- `reactivation.campaign.cancelled`
- `reactivation.recipient.blocked`
- `reactivation.message.sent`
- `reactivation.block_label.failed`
- `reactivation.customer.replied`

A detecção de resposta usa a última mensagem não-sistêmica fornecida pelo Chatwoot e só conta mensagem `incoming` posterior ao `sent_at`.

## Limite deliberado da V1

A V1 não faz reativação automática recorrente, não escolhe leads por IA e não força segunda reativação. Métricas de CPF, aprovação e venda devem ser conectadas posteriormente ao AutoCore/Event Ledger para não inferir conversão a partir de etiquetas imprecisas.
