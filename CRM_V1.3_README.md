# Kanban CRM V1.3 — Fundação centralizada

A V1.3 preserva a interface e a integração operacional da V1.2, mas retira a configuração principal do navegador e cria uma base central para a loja piloto.

## O que ficou centralizado

- organização e conexão com a conta Chatwoot;
- autenticação própria por e-mail e senha;
- perfis `admin`, `manager`, `agent` e `viewer`;
- pipeline, etapas, nomes, cores, ordem e arquivamento;
- filtros pessoais e filtros compartilhados;
- espelho central das tarefas comerciais;
- auditoria de acessos, usuários, pipeline, filtros e oportunidades;
- sessões persistidas no banco;
- token do Chatwoot criptografado no servidor.

## Banco adotado nesta fundação

A loja piloto usa **SQLite central** em arquivo persistente. Para uma única instância no Coolify, ele entrega uma base relacional, transações, integridade e backup simples sem adicionar um serviço externo agora.

A migração para PostgreSQL fica preparada como evolução necessária antes de múltiplas réplicas, múltiplas empresas em escala ou alto volume concorrente.

## Requisitos

- Node.js 22.5 ou superior;
- diretório persistente para o arquivo do banco;
- HTTPS em produção;
- uma chave longa em `CRM_ENCRYPTION_KEY`.

## Inicialização local

```bash
cp .env.example .env
npm install
npm run check
npm test
npm run dev
```

Na primeira execução, o banco vazio será criado e os dados de `CRM_ORGANIZATION_*`, `CRM_ADMIN_*` e `CHATWOOT_*` serão usados para criar a organização e o administrador.

Depois, o acesso ao painel é realizado com:

```text
CRM_ADMIN_EMAIL
CRM_ADMIN_PASSWORD
```

O token e o ID do Chatwoot deixam de ser informados por cada usuário.

## Coolify

Configure:

```env
NIXPACKS_NODE_VERSION=22
PORT=3000
BASE_URL=chat.autocredit.com.br
CRM_DB_PATH=/app/data/crm.sqlite
CRM_ENCRYPTION_KEY=<chave longa e aleatória>
CRM_SESSION_TTL_HOURS=12
CRM_ORGANIZATION_NAME=<nome da loja piloto>
CRM_ADMIN_NAME=<nome do administrador>
CRM_ADMIN_EMAIL=<email do administrador>
CRM_ADMIN_PASSWORD=<senha forte>
CHATWOOT_ACCOUNT_ID=<id da conta>
CHATWOOT_API_TOKEN=<token da conta>
```

Crie um volume persistente com destino:

```text
/app/data
```

Sem esse volume, o banco será perdido quando o contêiner for recriado.

## Perfis

| Perfil | Acesso |
|---|---|
| Administrador | usuários, permissões, pipeline, filtros, auditoria e operação |
| Gerente | pipeline, filtros compartilhados, auditoria e operação |
| Atendente | oportunidades, tarefas e mensagens |
| Somente leitura | consulta do dashboard, pipeline, conversas, tarefas e contatos |

## Compatibilidade com a V1.2

Os atributos comerciais continuam gravados nas conversas do Chatwoot:

- `crm_stage`
- `crm_value`
- `crm_next_task`
- `crm_task_due_at`
- `crm_task_done`
- `crm_task_completed_at`
- `crm_loss_reason`

Assim, as oportunidades já testadas não são perdidas. A V1.3 apenas centraliza usuários e configurações e passa a registrar alterações relevantes.

## Backup

Com a aplicação parada ou usando snapshot consistente do volume, preserve:

```text
/app/data/crm.sqlite
/app/data/crm.sqlite-wal
/app/data/crm.sqlite-shm
```

Em uma rotina automatizada, prefira executar backup consistente do SQLite em vez de copiar arquivos durante escrita intensa.
