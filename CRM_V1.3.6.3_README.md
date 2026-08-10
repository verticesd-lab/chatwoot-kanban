# CRM V1.3.6.3 — Inclusão manual auditável

Hotfix de UX e segurança operacional da Central de Reativação.

## Ajustes

- contatos adicionados manualmente ficam visíveis em uma seção própria na tela principal;
- o modal mostra os contatos já adicionados manualmente;
- contato manual pode ser removido tanto no modal quanto na seleção principal;
- inclusão manual exige motivo;
- motivo fica visível na seleção, na prévia e no histórico da campanha;
- motivo é persistido em `reactivation_recipients.source_reason`;
- contatos selecionados por etiqueta são diferenciados de inclusões manuais;
- a prévia lista todos os destinatários antes da confirmação.

## Segurança

A inclusão manual continua sem ignorar as proteções de reativação única, estágio terminal, campanha pendente ou envio incerto.

`REACTIVATION_SEND_ENABLED` não é alterado por este patch.
