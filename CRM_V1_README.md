# Kanban CRM V1.1 Operacional

Evolução do painel Kanban para uma experiência de CRM comercial inspirada em ferramentas como Kommo e GHL, mantendo o Chatwoot como fonte de conversas, contatos, agentes, times e mensagens.

## O que está incluído

- login com token protegido por sessão HTTP-only;
- dashboard comercial;
- pipeline independente do status do atendimento;
- sete etapas comerciais;
- drag-and-drop com persistência no Chatwoot;
- valor da oportunidade;
- cartões com agente, time, caixa de entrada, etiquetas e prioridade;
- indicador visual de tempo sem interação;
- busca por nome, telefone, número da conversa e mensagem;
- filtros por agente, time, inbox, etiqueta, prioridade e situação da tarefa;
- tarefas com estados pendente, vencida e concluída;
- registro da data e hora real da conclusão da tarefa;
- conclusão e reabertura rápida na própria agenda;
- atualização automática a cada 60 segundos e atualização manual;
- motivo de perda;
- tabelas de conversas e contatos;
- painel lateral com histórico;
- resposta pública e nota privada sem sair do CRM;
- alteração de prioridade, agente e time;
- botão para abrir a conversa no Chatwoot;
- paginação de conversas;
- renderização segura sem inserir conteúdo do cliente como HTML;
- ajustes de responsividade, largura dos cartões e rolagem horizontal do pipeline.

## Fonte dos dados

O CRM não cria uma base paralela nesta versão. Os dados comerciais são armazenados nos atributos personalizados da própria conversa:

- `crm_stage`
- `crm_value`
- `crm_next_task`
- `crm_task_due_at`
- `crm_task_done`
- `crm_task_completed_at`
- `crm_loss_reason`

O status do atendimento no Chatwoot continua separado da etapa comercial.

Exemplo:

- Chatwoot: `open`
- CRM: `negotiation`

## Atualização da V1 para a V1.1

Depois de substituir os arquivos, abra **Configurações** e clique novamente em **Inicializar atributos CRM**. Os atributos existentes serão preservados e somente `crm_task_completed_at` será criado, caso ainda não exista.

## Execução local

```powershell
npm install
npm run check
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

## Limites atuais

- um pipeline fixo com sete etapas;
- uma tarefa ativa por conversa;
- sem automações comerciais próprias;
- atualização automática por consulta periódica, ainda sem WebSocket próprio;
- sem banco paralelo ou histórico de múltiplas tarefas por oportunidade.
