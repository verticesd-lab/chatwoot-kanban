# Kanban CRM — Chatwoot Connected CRM

CRM comercial visual conectado ao Chatwoot. A interface mantém as conversas, mensagens, contatos, agentes, times, caixas e etiquetas no Chatwoot, enquanto organiza a operação comercial em um pipeline independente.

## Versão atual: V1.3.2 operacional

A V1.3.2 mantém a fundação central e acrescenta foco operacional:

- login próprio por e-mail e senha;
- usuários vinculados aos agentes do Chatwoot;
- funções Administrador, Gerente, SDR, Vendedor e Somente leitura;
- restrição real de leads aplicada no servidor;
- pipeline específico para a função de cada usuário;
- coluna de oportunidades pendentes de enquadramento;
- fila de intervenção para `precisa-humano` e `atendimento-manual`;
- dashboard **Minha fila agora**;
- auditoria central;
- token do Chatwoot criptografado;
- banco SQLite persistente para a loja piloto.

Consulte [CRM_V1.3.2_README.md](CRM_V1.3.2_README.md) para funções, escopos, intervenção humana e migração. O guia da fundação permanece em [CRM_V1.3_README.md](CRM_V1.3_README.md).

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
├── access-control.js # escopos, intervenções e prioridade operacional
├── db.js             # banco central, autenticação, perfis e auditoria
├── server.js         # API do CRM e proxy seguro para o Chatwoot
├── index.html        # interface
├── script.js         # comportamento do painel
└── styles.css        # apresentação

tests/
├── foundation.test.js
└── operational-scope.test.js
```

## Separação de responsabilidades

**Chatwoot:** contatos, conversas, mensagens, agentes, times, caixas e etiquetas.

**Kanban CRM:** usuários, permissões, pipeline, etapas, filtros, auditoria e gestão comercial.

Os atributos comerciais continuam sendo gravados nas conversas do Chatwoot para manter compatibilidade com a V1.2 e preservar os dados já validados.
