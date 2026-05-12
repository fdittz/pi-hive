# Testando Handoff em pi-hive

## O que é Handoff?

Um **handoff** é quando um subagent pede ao pi pai que invoque outro agente. Child processes não recebem as ferramentas `subagent`/`subagent_continue`; em vez disso, recebem a ferramenta real `handoff`.

A chamada de tool usa estes parâmetros:

```json
{
  "agent": "reviewer",
  "task": "Review the changes for security issues",
  "reason": "I made changes and want them reviewed"
}
```

O parent pi captura a chamada no transcript do child e executa automaticamente (por padrão). Blocos JSON no output final ainda são aceitos como fallback legado.

---

## Cenário de Teste 1: Handoff Manual (Mais Controlado)

### 1. Criar um agent de teste que emita handoff

Salve como `~/.pi/agent/agents/test-handoff-worker.md`:

```markdown
---
name: test-handoff-worker
description: Test agent that performs a simple task and hands off to reviewer
tools: read, grep, find, ls, handoff
model: inherit
thinking: inherit
color: green
---

You are a test worker. Your job is:
1. Read the file: /path/to/pi-hive/index.ts
2. Count how many times "subagent" appears in the first 50 lines
3. Report the count
4. Use the `handoff` tool to ask the reviewer agent to review your methodology

Important: Call the `handoff` tool with:

\`\`\`json
{
  "agent": "reviewer",
  "task": "Review my approach for counting 'subagent' occurrences. Was my methodology sound?",
  "reason": "I want another agent to validate my work"
}
\`\`\`
```

### 2. Invocar o agent de teste

No pi, execute:

```
/subagent
agent: test-handoff-worker
task: Do your work
```

Ou:

```typescript
// Via tool JSON
{
  "agent": "test-handoff-worker",
  "task": "Please complete your task"
}
```

### 3. Observar o fluxo

Na interface, você verá:

```
✓ test-handoff-worker (completed)
  → Counted 23 occurrences of "subagent"
  → Found handoff request to "reviewer"
  
✓ reviewer (started as handoff)
  → Reviewing the methodology...
  → Your approach was sound...
```

---

## Cenário de Teste 2: Chain com Handoff Automático

Crie um chain que espera uma chamada de handoff:

```typescript
{
  "chain": [
    {
      "agent": "test-handoff-worker",
      "task": "Do your task and call the handoff tool for reviewer when done"
    }
  ]
}
```

O pi vai:
1. Executar `test-handoff-worker`
2. Capturar a chamada da ferramenta `handoff` no transcript
3. Executar `reviewer` automaticamente como continuação

---

## Cenário de Teste 3: Verificar que Nested Calls Não Funcionam

### Teste: Confirmar que worker NÃO pode invocar subagent

Crie `~/.pi/agent/agents/test-no-nested.md`:

```markdown
---
name: test-no-nested
description: Test that child processes cannot call subagent
tools: bash, handoff
---

Try to call the subagent tool to run the reviewer.

Your instruction: Invoke the subagent tool with:
{
  "agent": "reviewer", 
  "task": "Review this attempt"
}

If the tool is not available, explain that child processes cannot use subagent directly.
```

Quando você tentar:

```
/subagent
agent: test-no-nested
task: Try to invoke another subagent
```

Esperado:
- ❌ Tool `subagent` não está disponível no child process
- ✅ A tool `handoff` está disponível quando incluída em `tools` (ou quando o agent usa tools padrão)

---

## Cenário de Teste 4: Múltiplos Handoffs

Um agent pode solicitar múltiplos handoffs fazendo múltiplas chamadas da tool `handoff`:

```markdown
---
name: test-multi-handoff
description: Emit multiple handoff requests
---

I will do some analysis and then call the `handoff` tool twice:

1. reviewer — Review for security issues — reason: Security audit
2. planner — Plan refactoring based on the security review — reason: Planning for improvements
```

O pi executará ambos os handoffs em sequência. O fallback legado com `{ "handoffs": [...] }` ainda é suportado, mas a tool é o caminho preferido.

---

## Cenário de Teste 5: Testar Descoberta Dinâmica + Handoff

### 1. Criar agent customizado

`~/.pi/agent/agents/custom-analyzer.md`:

```markdown
---
name: custom-analyzer
description: Analyzes code structure
when: when you need detailed code structure analysis
examples:
  - "Analyze the function signatures in index.ts"
  - "Find all exported functions"
triggers: analyze, structure, functions, exports
tools: read, grep, find, ls, handoff
---

You are a code analyzer. Your job:
1. Find all function declarations in /path/to/pi-hive/agents.ts
2. List them with brief descriptions
3. Use the `handoff` tool to ask reviewer for validation:

\`\`\`json
{
  "agent": "reviewer",
  "task": "Validate the list of functions I found",
  "reason": "Want to ensure I didn't miss anything"
}
\`\`\`
```

### 2. Invocar em linguagem natural

Diga ao pi:
> "Analyze the code structure in agents.ts and let me know if you found all the functions"

O pi vai:
1. ✅ Sugerir `custom-analyzer` (por discovery dinâmico + guidance)
2. ✅ Invocar `custom-analyzer` se o modelo escolher
3. ✅ Capturar a chamada de handoff
4. ✅ Invocar `reviewer` automaticamente

---

## Debugging: Habilitar Logs de Handoff

Set env var antes de rodar:

```bash
PI_HIVE_DEBUG=1 pi
```

Logs mostrarão eventos como:
- `[pi-hive:handoff] extractHandoffRequestsFromMessages: parsed 1 handoff request(s)`
- `[pi-hive] executeHandoffsForResult: sourceAgent=...`
- `[pi-hive:handoff] decideHandoff: allowed ...`
- `[pi-hive] executeHandoffsForResult: executing handoff ...`

---

## Checklist de Testes

- [ ] Agent chama a tool `handoff` com `{ "agent": ..., "task": ... }`
- [ ] Parent captura e executa o handoff automaticamente
- [ ] Child process NÃO consegue chamar ferramenta `subagent` (usa `handoff` instead)
- [ ] Chain com handoff funciona
- [ ] Múltiplas chamadas de `handoff` funcionam
- [ ] Custom agents com metadata são descobertos
- [ ] Guidance dinâmico sugere usar os agents

---

## Parâmetros Esperados da Tool `handoff`

```typescript
{
  "agent": "reviewer",          // obrigatório: nome do agent
  "task": "Review the code",    // obrigatório: tarefa
  "reason": "Security audit"    // opcional: por que fazer handoff
}
```

Para múltiplos handoffs, faça múltiplas chamadas da tool.

## Fallback legado em JSON

Para compatibilidade com prompts antigos, o parent ainda tenta extrair JSON no output final:

```typescript
{
  "handoff": {
    "agent": "reviewer",
    "task": "Review the code",
    "reason": "Security audit",
    "cwd": "/some/path"
  }
}
```

Ou múltiplos:

```typescript
{
  "handoffs": [
    { "agent": "reviewer", "task": "...", "reason": "..." },
    { "agent": "planner", "task": "...", "reason": "..." }
  ]
}
```

---

## Referências

- `handoff.ts` - Lógica de handoff
- `index.ts` - `executeHandoffsForResult()` executa handoffs
- `README.md` - Overview de handoff automático
