# Changelog

## 0.1.0

- Workspace discovery for npm, yarn, bun and pnpm, or a single package.
- Import scanning with relative, workspace package and tsconfig path alias resolution.
- Package classification (web, API, worker, CLI, library) and external system detection from client libraries.
- Markdown output with system context, container, package and component diagrams in Mermaid, and a rule check table.
- Structurizr DSL and JSON output.
- `view`: a self-contained HTML page with the package graph, details per package and the violations.
- Rules: `cycles`, `undeclared-dependency`, `unused-dependency`, `layers`, `forbidden`.
- `check --up-to-date` for CI and GitHub annotations.
