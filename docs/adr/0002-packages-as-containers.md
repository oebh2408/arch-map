# 2. Workspace packages as C4 containers, folders as components

## Context

C4 containers are things that run or store data: a web app, an API, a database. In a monorepo, deployable units are usually workspace packages under `apps/`, and shared code lives in library packages that are not deployed on their own.

## Decision

- Deployable packages (web, API, worker, CLI) are containers. Their kind is inferred from dependencies and scripts, and can be overridden in `package.json`.
- Libraries are not shown in the container diagram. External systems a library uses are attributed to every container that depends on it, labelled with the library, so the container view still shows that the API reaches PostgreSQL through `@shop/db`.
- All packages, including libraries, appear in the package dependency diagram, where rules are checked.
- Components are the first level of folders below `src/`, `app/` or `lib/`.

## Consequences

- The container diagram stays readable in repositories with many small libraries.
- Folder structure is a proxy for components. It works for the usual `routes/services/repositories` layouts and is less useful when everything is in one folder.
