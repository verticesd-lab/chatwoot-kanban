# CRM V1.3.3 — Controle operacional

A V1.3.3 evolui a fundação da V1.3.2 sem alterar a responsabilidade do Chatwoot sobre conversas, contatos, mensagens, etiquetas, agentes, times e caixas.

O objetivo desta versão é manter a área diária limpa e, ao mesmo tempo, preservar histórico, auditoria e controle de carteira.

## Recursos adicionados

### Encaminhamento controlado

- **SDR:** encaminha para vendedor ou escala para gerente.
- **Vendedor:** devolve para SDR, escala para gerente ou solicita redistribuição.
- **Gerente e Administrador:** transferência completa entre responsáveis autorizados.
- Toda ação exige motivo e gera registro de auditoria.
- O encaminhamento da SDR para vendedor move automaticamente a oportunidade para `Proposta`.
- A devolução do vendedor para SDR move automaticamente para `Qualificação`.
- SDR e vendedor não possuem acesso ao endpoint livre de atribuição.

### Arquivamento seguro

- Disponível somente para Gerente e Administrador.
- Exige confirmação e motivo.
- Retira o card das filas e do Pipeline ativo.
- Preserva conversa, contato, mensagens, etiquetas e histórico no Chatwoot.
- Mantém trilha de auditoria no banco central.
- Permite restaurar a oportunidade.

A versão não oferece exclusão definitiva pelo Pipeline.

### Presença da equipe

O CRM registra atividade de sessão e apresenta um indicador compacto:

- **Online:** atividade nos últimos 2 minutos.
- **Ausente:** sem atividade entre 2 e 10 minutos.
- **Offline:** mais de 10 minutos sem atividade ou nenhum acesso registrado.

O indicador é operacional e não deve ser interpretado isoladamente como produtividade.

### Pipeline e histórico

- Ganho e Perdido possuem filtro de período.
- Padrão do Pipeline: últimos 7 dias para oportunidades encerradas.
- Opções: hoje, 7 dias, 30 dias, mês atual, período personalizado e todo o histórico.
- A tela **Histórico** reúne Ganho e Perdido sem poluir o quadro diário.
- A busca global também funciona no Histórico e no Arquivo.
- Cada coluna mostra inicialmente 50 cards e oferece `Mostrar mais`.

### Correção visual dos cards

- empilhamento em coluna com espaçamento fixo;
- altura natural preservada;
- faixa de tempo sem interação contida na borda do card;
- sem sobreposição entre cards;
- etiquetas quebram linha sem ultrapassar a coluna;
- rolagem vertical independente por etapa.

## Novas tabelas SQLite

```text
user_presence
archived_opportunities
transfer_requests
```

A migração é automática ao iniciar a aplicação. O banco existente permanece compatível.

## Novos atributos do Chatwoot

```text
crm_outcome_at
```

Ele registra quando a oportunidade foi marcada como Ganho ou Perdido. O bootstrap do CRM cria o atributo quando necessário.

## Permissões

| Função | Visibilidade | Encaminhamento | Arquivar |
|---|---|---|---|
| Administrador | Todos | Completo | Sim |
| Gerente | Todos | Completo | Sim |
| SDR | Fila SDR + próprios | Vendedor ou gerente | Não |
| Vendedor | Somente próprios | SDR, gerente ou solicitação | Não |
| Somente leitura | Conforme escopo | Não | Não |

## Desenvolvimento local

```bash
npm run check
npm test
npm run dev
```

Acesse:

```text
http://localhost:3000
```

## Validação operacional recomendada

1. SDR encaminha um lead a um vendedor e o card entra em `Proposta`.
2. Vendedor devolve o lead para SDR e o card entra em `Qualificação`.
3. Vendedor solicita redistribuição e a gestão aprova ou rejeita.
4. Vendedor tenta usar atribuição livre e recebe bloqueio de permissão.
5. Gerente arquiva uma oportunidade de teste e confirma que ela sai do Pipeline.
6. Gerente restaura a oportunidade pelo Arquivo.
7. Alterar Ganho/Perdido e conferir o filtro de período.
8. Abrir várias sessões e confirmar Online, Ausente e Offline.
9. Validar colunas cheias, etiquetas longas e ausência de sobreposição.
10. Confirmar que usuários, tarefas e oportunidades anteriores permanecem intactos.

## Produção

O diretório configurado em `CRM_DB_PATH` deve estar em armazenamento persistente. No Coolify, o caminho recomendado continua sendo:

```text
/app/data/crm.sqlite
```

O redeploy não deve remover o volume montado em `/app/data`.
