-- Rollback da 0096 (Épico 19 · story 19.3a): remove o registro de módulos por loja.
-- Apaga o estado ligado/desligado e a trilha de auditoria. A tabela `stores`
-- não é afetada. Sem as tabelas, o painel volta a mostrar tudo (fail-open) e a
-- home lê todas as fontes; volte o código antes se quiser evitar os avisos.

DROP TABLE IF EXISTS "store_module_events";
DROP TABLE IF EXISTS "store_modules";
