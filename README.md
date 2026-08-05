# Kanban CRM — Chatwoot Connected CRM

CRM comercial visual conectado ao Chatwoot. A interface mantém as conversas, mensagens, contatos, agentes, times, caixas e etiquetas no Chatwoot, enquanto organiza a operação comercial em um pipeline independente.

## Versão atual: V1.3 central

A V1.3 acrescenta a fundação necessária para uso real por uma equipe:

- login próprio por e-mail e senha;
- organização e conexão Chatwoot configuradas no servidor;
- usuários e permissões por perfil;
- pipeline e etapas compartilhados;
- filtros pessoais e compartilhados;
- auditoria central;
- espelho central das tarefas;
- token do Chatwoot criptografado;
- banco SQLite persistente para a loja piloto.

Consulte [CRM_V1.3_README.md](CRM_V1.3_README.md) para configuração local, implantação no Coolify, volume persistente, perfis e backup.

## Funcionalidades operacionais preservadas

- dashboard comercial;
- pipeline drag-and-drop;
- etapas configuráveis;
- valor da oportunidade;
- ganho e perda com validação;
- tarefas, prazos e conclusão;
- busca e filtros;
- agente, time, caixa, prioridade e etiquetas;
- painel lateral com histórico;
- mensagens públicas e notas privadas;
- abertura direta da conversa no Chatwoot;
- atualização automática.

## Requisitos

- Node.js 22.5 ou superior;
- npm;
- uma conta Chatwoot acessível pela API;
- diretório persistente para o banco em produção.

## Instalação

```bash
cp .env.example .env
npm install
npm run check
npm test
npm run dev
```

Acesse:

```text
http://localhost:3000
```

## Estrutura

```text
src/
├── db.js       # banco central, autenticação, permissões e auditoria
├── server.js   # API do CRM e proxy seguro para o Chatwoot
├── index.html  # interface
├── script.js   # comportamento do painel
└── styles.css  # apresentação

tests/
└── foundation.test.js
```

## Separação de responsabilidades

**Chatwoot:** contatos, conversas, mensagens, agentes, times, caixas e etiquetas.

**Kanban CRM:** usuários, permissões, pipeline, etapas, filtros, auditoria e gestão comercial.

Os atributos comerciais continuam sendo gravados nas conversas do Chatwoot para manter compatibilidade com a V1.2 e preservar os dados já validados.
