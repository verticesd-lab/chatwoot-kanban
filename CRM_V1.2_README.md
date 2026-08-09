# Kanban CRM V1.2 — Pipeline configurável

## Novidades

- Etapas configuráveis: criar, renomear, recolorir, reordenar, arquivar e excluir.
- Proteção: etapas com oportunidades não podem ser arquivadas ou excluídas.
- Etapas críticas `new`, `won` e `lost` são protegidas.
- Ações rápidas nos cartões para tarefa, responsável, ganho, perda e Chatwoot.
- Fechamento ganho exige valor final; perda exige motivo.
- Filtros salvos no navegador, sem armazenar token.
- Uma única rolagem horizontal do pipeline e colunas com cabeçalho fixo.
- Status do Chatwoot continua independente da etapa comercial.

## Persistência

- Etapa, valor e motivo continuam gravados nos atributos da conversa no Chatwoot.
- Nomes, cores, ordem das etapas e filtros salvos ficam no `localStorage` deste navegador.
- Ao criar/excluir etapa, os IDs permitidos de `crm_stage` são sincronizados com o Chatwoot.

## Validação

```bash
npm install
npm run check
npm run dev
```
