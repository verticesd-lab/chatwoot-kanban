# CRM V1.3.5 — Supressão de Leads Arquivados

## Objetivo

Evitar que leads de teste, cadastros incorretos e contatos sem valor operacional retornem ao Pipeline por meio de outra conversa do mesmo contato.

## Regra nova

O arquivamento passa a ter dois alcances:

- **Lead de teste**, **Cadastro incorreto** e **Sem valor operacional**: arquivamento por contato. A conversa selecionada continua registrada no Arquivo e todas as outras conversas com a mesma identidade de contato deixam de aparecer na área de trabalho.
- **Duplicado** e **Outro**: arquivamento somente da conversa selecionada, preservando outras conversas válidas do mesmo contato.

A identidade do contato prioriza o telefone normalizado, com fallback para identificador, e-mail, ID do contato e, por último, ID da conversa.

## Compatibilidade com registros existentes

Arquivos antigos com motivo **Lead de teste**, **Cadastro incorreto** ou **Sem valor operacional** passam a suprimir automaticamente as outras conversas do mesmo contato após o deploy, sem necessidade de arquivar novamente.

## Segurança

- Nenhuma conversa é apagada do Chatwoot.
- O histórico continua disponível na área de Arquivo.
- O arquivamento continua restrito a perfis com `archive:manage`.
- O motivo **Duplicado** não bloqueia o contato inteiro.

## Testes

A V1.3.5 adiciona testes específicos para:

- múltiplas conversas do mesmo telefone;
- compatibilidade com arquivos legados;
- não supressão global no motivo `Duplicado`;
- escopo explícito por contato.
