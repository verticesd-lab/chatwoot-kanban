# Diagnóstico de login CRM V1.3.2

Este utilitário usa exatamente o `CRM_DB_PATH` do `.env` e a função `authenticate()` do CRM.
Ele localiza o usuário, mostra cadastro/vínculo sem revelar segredos, redefine a senha no mesmo banco, apaga sessões antigas e valida a autenticação diretamente.

Execute com o servidor local parado.
