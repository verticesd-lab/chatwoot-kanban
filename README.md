# Kanban CRM — Chatwoot Connected CRM

CRM comercial visual conectado ao Chatwoot. A interface mantém as conversas, mensagens, contatos, agentes, times, caixas e etiquetas no Chatwoot, enquanto organiza a operação comercial em um pipeline independente.

## Versão atual: V1.3.3 — controle operacional

A V1.3.3 preserva os escopos da V1.3.2 e acrescenta:

- encaminhamento controlado por função e motivo obrigatório;
- solicitações de redistribuição para a gestão;
- arquivamento seguro com restauração;
- presença online, ausente e offline;
- Histórico separado para Ganho e Perdido;
- filtro de encerrados por período;
- carregamento progressivo de 50 cards por coluna;
- correção definitiva de sobreposição e etiquetas;
- auditoria de encaminhamentos, arquivos e restaurações.

Consulte [CRM_V1.3.3_README.md](CRM_V1.3.3_README.md) para o escopo e os testes desta versão. Os detalhes dos perfis e da fila de intervenção permanecem em [CRM_V1.3.2_README.md](CRM_V1.3.2_README.md).

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
├── operational-scope.test.js
├── operational-control.test.js
└── static-contract.test.js
```

## Separação de responsabilidades

**Chatwoot:** contatos, conversas, mensagens, agentes, times, caixas e etiquetas.

**Kanban CRM:** usuários, permissões, pipeline, etapas, filtros, auditoria e gestão comercial.

Os atributos comerciais continuam sendo gravados nas conversas do Chatwoot para manter compatibilidade com a V1.2 e preservar os dados já validados.
