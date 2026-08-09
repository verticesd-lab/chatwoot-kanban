# CRM V1.3.4 — Central de Tutoriais

A V1.3.4 adiciona uma central interna de vídeos para treinamento, suporte e comunicação de atualizações sem tirar a equipe do CRM.

## Experiência da equipe

Nova opção no menu lateral:

```text
Tutoriais
```

A aba **Assistir vídeos** fica disponível para todos os perfis autenticados e oferece:

- cards com miniatura, título, categoria e descrição;
- filtros por categoria;
- reprodução dentro do próprio CRM em player modal;
- integração com vídeos do YouTube configurados como **Não listado**;
- nenhuma necessidade de abrir uma nova página para assistir.

## Gerenciamento

A aba **Gerenciar** é disponibilizada somente para **Administrador** e **Gerente**.

Campos disponíveis:

- link do YouTube;
- título;
- descrição opcional;
- categoria;
- ordem de exibição;
- ativo/inativo.

A gestão pode:

- cadastrar;
- editar;
- visualizar;
- ativar/desativar;
- excluir.

## Segurança

- O backend valida o domínio e o ID do vídeo do YouTube.
- O iframe é construído a partir do ID validado, usando `youtube-nocookie.com`.
- Vendedores, SDR e perfis de leitura não possuem endpoints de alteração dos tutoriais.
- As ações de criação, edição e exclusão entram na auditoria central.
- A Content Security Policy libera apenas os hosts necessários para player e miniatura do YouTube.

## Banco de dados

Nova tabela SQLite:

```text
tutorial_videos
```

A criação é automática no startup e não exige migration manual.

## Permissões

| Perfil | Assistir | Gerenciar |
|---|---:|---:|
| Administrador | Sim | Sim |
| Gerente | Sim | Sim |
| SDR | Sim | Não |
| Vendedor | Sim | Não |
| Atendente | Sim | Não |
| Somente leitura | Sim | Não |

## Links aceitos

Exemplos:

```text
https://www.youtube.com/watch?v=VIDEO_ID
https://youtu.be/VIDEO_ID
https://www.youtube.com/shorts/VIDEO_ID
https://www.youtube.com/embed/VIDEO_ID
```

Para a equipe conseguir assistir por link, o vídeo deve ser publicado como **Não listado** no YouTube. Um vídeo configurado como **Privado** exige autorização individual do Google e não atende ao fluxo simples de treinamento interno.

## Validação

```bash
npm run check
npm test
```

Teste operacional recomendado:

1. entrar como Administrador;
2. abrir `Tutoriais > Gerenciar`;
3. cadastrar um vídeo Não listado;
4. confirmar miniatura e categoria;
5. abrir `Assistir vídeos` e reproduzir sem sair do CRM;
6. entrar como Vendedor e confirmar que `Gerenciar` não aparece;
7. desativar o vídeo e confirmar que ele some da área da equipe;
8. reativar e validar novamente.


## Hotfix — YouTube Error 153

O player embutido precisa enviar a origem do CRM ao YouTube. A política global de referrer foi ajustada de `same-origin` para `strict-origin-when-cross-origin`, preservando somente a origem em navegação cross-origin e permitindo a identificação exigida pelo player do YouTube. O iframe também declara a mesma política explicitamente.
