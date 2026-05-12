# Instruções do `/init` para gerar o CLAUDE.md

Este arquivo descreve as instruções que o Claude Code usa internamente ao executar `/init`.

---

## Prompt base

> Analise este repositório e crie um arquivo `CLAUDE.md`, que será fornecido a futuras instâncias do Claude Code para operar neste repositório.

---

## O que incluir

1. **Comandos comuns de desenvolvimento** — como fazer build, lint e rodar testes. Inclua os comandos necessários para desenvolver no projeto, incluindo como rodar um único teste.

2. **Arquitetura e estrutura de alto nível** — para que futuras instâncias possam ser produtivas mais rapidamente. Foco no "big picture" que requer leitura de múltiplos arquivos para ser compreendido.

---

## Regras

- Se já existir um `CLAUDE.md`, sugerir melhorias em vez de criar do zero.
- Não repetir informações e não incluir instruções óbvias como:
  - "Forneça mensagens de erro úteis"
  - "Escreva testes unitários para todos os utilitários"
  - "Nunca inclua informações sensíveis (API keys, tokens) no código ou commits"
- Evitar listar cada componente ou estrutura de arquivos que pode ser facilmente descoberta.
- Não incluir práticas genéricas de desenvolvimento.
- Se houver regras do Cursor (`.cursor/rules/` ou `.cursorrules`) ou Copilot (`.github/copilot-instructions.md`), incluir as partes relevantes.
- Se houver `README.md`, incluir as partes importantes.
- Não inventar seções como "Tarefas Comuns", "Dicas para Desenvolvimento", "Suporte" a menos que existam em outros arquivos do repo.

---

## Prefixo obrigatório

```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
```
