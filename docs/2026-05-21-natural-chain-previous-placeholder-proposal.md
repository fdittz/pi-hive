# 
# Proposta: Auto-inclusão de `{previous}` em todas as chains naturais (pi-hive)

## Resumo
Adotar um mecanismo que insira automaticamente `{previous}` no campo `task` de todos os steps (a partir do segundo) de cadeias de subagentes (chains), inclusive quando a chain for criada por pedido natural (não só templates slash), garantindo passagem de contexto sempre, exceto se explicitamente desativado por feature flag.

---

## Motivação
- Usuários frequentemente criam chains descritivas ("faça o estudo com o scout, depois planeje com o planner") sem explicitamente usar `{previous}`.
- O padrão atual exige uso manual do placeholder para passar contexto.
- Essa lacuna gera _"steps cegos"_, perda de produtividade, duplicidade e respostas genéricas.
- Chains de templates slash já são modeladas corretamente, mas comandos livres não.

## Solução Proposta

- **Interceptar chains antes da execução**, no ponto de orquestração (subagent chain executor ou subagent tool invocation). Verificar se há `params.chain`.
- **Para cada step a partir do segundo (`i >= 1`)**, verificar se o campo `task` contém algum `{previous}` (ignorando case/whitespace).
- **Se não contém:**
    - Inserir o bloco ao final do `task`, delimitado, idealmente assim:
      ```
      \n\nContexto do passo anterior (auto-inserido):\n{previous}\n```
- **Evitar duplicatas:**
    - Não agir se encontrar `{previous}`, `{ previous }`, `{Previous}`, etc.
- **Configuração:**
    - Feature flag em `~/.pi/agent/subagent.json`, exemplo:
      ```json
      {
        "chain": { "autoInjectPrevious": { "enabled": true, "mode": "append-block" } }
      }
      ```
    - **Default: ativado**.
- **Permitir desligar:**
    - Usuário pode pôr `enabled: false` no config para desabilitar.
- **Heurística de formatação:**
    - Caso o `task` termine em pontuação, preferir `\n\n` antes do bloco.
    - Respeitar que prompts excessivamente longos (>10k tokens) podem ser truncados (não alterar este comportamento).

## Especificação Técnica

### Ponto de Inserção
- Função/módulo chamado antes de cada execução de chain (logo após parsing, antes dos agentes filhos serem invocados)
- Exemplo de função:
  ```js
  function normalizeChainPrevious(chain) {
    for (let i = 1; i < chain.length; i++) {
      if (!hasPreviousPlaceholder(chain[i].task)) {
        chain[i].task += '\n\nContexto do passo anterior (auto-inserido):\n{previous}';
      }
    }
    return chain;
  }
  function hasPreviousPlaceholder(task) {
    return /\{\s*previous\s*\}/i.test(task);
  }
  ```
- Chamar `normalizeChainPrevious` no executor de chains, **antes do loop de execução**.

### Testes & Documentação
- Teste unitário: garantir saída igual mesmo para tasks com espaçamentos e variações.
- Atualizar docs (`AGENTS.md`, `EXTENSION.md`), especificando que, por default, chains terão passagem automática de contexto.

### Side-Effects & Observações
- Para chains cujos steps são logicamente independentes, usuário pode:
  - Desabilitar por config;
  - Remover `{previous}` manualmente no prompt antes de execução.
- Para compatibilidade futura, considerar opção de formato custom do bloco.

## Passos de Implementação

1. Criar utilitário `normalizeChainPrevious(chain, enabled=true)`.
2. Ler feature flag de subagent config (default: true).
3. Integrar chamada normalizadora no codepath de execução de chains.
4. Testar edge cases de tasks ja contendo `{previous}` (com, sem espaço, case variants).
5. Documentar config nova e atualizar exemplos de chain.
6. Sugerir, futuramente, UI para toggle dessa opção e formatação custom block.

---

*Data: 2026-05-21 – Proposta aprovada para implementação*
