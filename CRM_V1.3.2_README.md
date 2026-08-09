# VR Multimarcas CRM V1.3.2 — Escopos operacionais e intervenção humana

A V1.3.2 preserva a identidade visual, pipeline, etiquetas coloridas, tarefas, usuários, auditoria e banco persistente da V1.3. Ela acrescenta foco operacional real para SDR e vendedores.

## Objetivos

- cada usuário recebe do servidor somente os leads do próprio escopo;
- SDR visualiza leads sem responsável e leads atribuídos a ela;
- vendedor visualiza somente leads atribuídos ao agente vinculado;
- administrador e gerente visualizam toda a operação;
- conversas com `precisa-humano` ou `atendimento-manual` entram em uma fila prioritária;
- cada usuário encontra rapidamente a próxima obrigação no dashboard.

## Funções operacionais

| Função | Escopo padrão | Etapas principais |
|---|---|---|
| Administrador | todos os leads | todas |
| Gerente | todos os leads | todas |
| SDR | sem responsável + meus leads | Novo lead, Contato iniciado, Qualificação |
| Vendedor | somente meus leads | Proposta, Negociação, Ganho, Perdido |
| Somente leitura | configurável | conforme o escopo |

O escopo é aplicado no servidor. Limpar filtros no navegador não permite acessar leads de outro usuário.

## Vínculo com o Chatwoot

No cadastro do usuário, configure:

- função operacional;
- agente correspondente no Chatwoot;
- escopo de visualização.

SDR e vendedor precisam obrigatoriamente estar vinculados a um agente do Chatwoot.

## Intervenção humana

As etiquetas abaixo são tratadas como trava operacional:

- `precisa-humano` — o fluxo detectou uma situação que exige avaliação humana;
- `atendimento-manual` — um humano assumiu e a automação deve permanecer bloqueada.

A interface oferece:

- contador no menu lateral;
- tela exclusiva de intervenções;
- destaque vermelho nos cards;
- prioridade máxima na fila pessoal;
- botão **Assumir atendimento**;
- botão **Resolver e liberar fluxo**;
- auditoria de detecção, assunção e resolução.

### Assumir atendimento

A ação:

1. atribui a conversa ao agente Chatwoot vinculado ao usuário;
2. remove `precisa-humano`;
3. aplica `atendimento-manual`;
4. preserva etapa, valor, tarefa e demais etiquetas.

### Resolver e liberar fluxo

A ação remove somente:

- `precisa-humano`;
- `atendimento-manual`.

As demais etiquetas e os dados comerciais são preservados.

## Pipeline por função

A SDR vê as etapas iniciais. O vendedor vê as etapas comerciais finais. Caso um lead esteja atribuído ao usuário, mas permaneça em uma etapa fora do conjunto esperado, ele aparece na coluna:

```text
Pendente de enquadramento
```

Assim nenhum lead desaparece por estar em uma etapa inadequada.

## Minha fila agora

A ordem de prioridade do dashboard é:

1. intervenção humana;
2. tarefa vencida;
3. retorno previsto para hoje;
4. lead sem responsável;
5. lead com mais de 24 horas sem interação;
6. oportunidade sem próxima tarefa;
7. demais oportunidades.

## Migração do banco

A atualização é automática na primeira inicialização da V1.3.2. O sistema acrescenta ao banco existente:

- função operacional;
- vínculo com agente Chatwoot;
- escopo de visualização;
- registro central de intervenções.

Não apague o volume `/app/data` nem o arquivo `crm.sqlite`.

## Validação

```bash
npm run check
npm test
npm run dev
```

Testes incluídos:

- fundação central;
- criação de SDR e vendedor;
- permissões por função;
- escopo `all`, `mine` e `unassigned_and_mine`;
- detecção, assunção e resolução de intervenção;
- fechamento correto do SQLite no Windows.


## Correção de foco da fila SDR

O escopo `unassigned_and_mine` para usuários com função `sdr` não inclui mais todo o histórico sem responsável. A fila sem responsável é limitada às conversas que possuam uma destas etiquetas operacionais:

- `aguardando-analise-manual`;
- `precisa-humano`;
- `atendimento-manual`.

Conversas já atribuídas ao agente Chatwoot vinculado à SDR continuam visíveis mesmo sem essas etiquetas. Administradores, gerentes e vendedores mantêm suas regras anteriores.
