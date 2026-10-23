# 1. Generate diagrams from the code, check them in CI

## Context

Architecture diagrams are usually drawn by hand once and then drift. Tools that draw from a model (Structurizr, C4-PlantUML) still need someone to keep the model in sync with the code.

## Decision

The model is derived from what is already in the repository: workspace packages, their `package.json` dependencies and the imports in their source files. The output is a Markdown file with Mermaid diagrams, because GitHub, GitLab and most editors render Mermaid without plugins. `arch-map check --up-to-date` regenerates the document and compares it with the committed copy.

## Consequences

- The diagrams are only as rich as what can be read from code. Intent that is not in the code (why a boundary exists) goes in the config as layer names and rule reasons.
- The output must be deterministic. Nothing in it depends on time, file system order or the machine.
- Mermaid layout is automatic and cannot be tuned per diagram. Structurizr DSL is offered for teams that want more control.
