# Kanban CRM V1

Primeira evolução do painel Kanban para uma experiência de CRM comercial inspirada em ferramentas como Kommo e GHL, mantendo o Chatwoot como fonte de conversas, contatos, agentes, times e mensagens.

## O que já está incluído

- login com token protegido por sessão HTTP-only;
- dashboard comercial;
- pipeline independente do status do atendimento;
- sete etapas comerciais;
- drag-and-drop entre etapas;
- valor de oportunidade;
- próxima tarefa, prazo e conclusão;
- motivo de perda;
- filtros por agente, time, inbox e etiqueta;
- busca global;
- tabelas de conversas e contatos;
- painel lateral com histórico;
- resposta pública e nota privada sem sair do CRM;
- alteração de prioridade, agente e time;
- botão para abrir a conversa no Chatwoot;
- paginação de conversas;
- renderização segura sem inserir conteúdo do cliente como HTML.

## Fonte dos dados

O CRM não cria uma base paralela nesta versão. Os dados comerciais são armazenados nos atributos personalizados da própria conversa:

- `crm_stage`
- `crm_value`
- `crm_next_task`
- `crm_task_due_at`
- `crm_task_done`
- `crm_loss_reason`

O status do atendimento no Chatwoot continua separado da etapa comercial.

Exemplo:

- Chatwoot: `open`
- CRM: `negotiation`

## Primeiro acesso

1. Entre com o token pessoal do Chatwoot e o ID da conta.
2. Abra **Configurações**.
3. Clique em **Inicializar atributos CRM**.
4. Volte ao Pipeline e abra uma oportunidade.
5. Defina etapa, valor e próxima tarefa.

## Execução local

```powershell
npm install
npm run dev
```

Acesse:

```text
http://localhost:3000
```

## Produção no Coolify

Variáveis:

```env
BASE_URL=chat.autocredit.com.br
PORT=3000
NODE_ENV=production
```

Comando de início:

```text
npm start
```

Porta interna:

```text
3000
```

## Observações da V1

- O gerenciamento de múltiplos funis ainda não está incluído.
- As etapas estão definidas em `src/script.js`, na constante `PIPELINE_STAGES`.
- Tarefas são vinculadas a oportunidades, uma tarefa ativa por conversa nesta fase.
- Não há automações comerciais próprias nesta versão.
- A atualização é feita pelo botão de sincronização; webhooks em tempo real ficam para a próxima etapa.
