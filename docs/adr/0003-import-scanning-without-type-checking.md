# 3. Read imports with the TypeScript preprocessor

## Context

Finding dependencies precisely would mean building a full TypeScript program per package, which is slow on large repositories and needs every package's tsconfig and dependencies installed correctly.

## Decision

Imports are read with `ts.preProcessFile`, which parses import, export-from, `require` and dynamic `import()` without type checking. Specifiers are resolved by arch-map: relative paths to files in the workspace (including `.js` to `.ts` mapping and `index` files), bare specifiers to workspace packages by name, `tsconfig` path aliases from the root config, and everything else to third-party packages.

## Consequences

- It runs in seconds on large repositories and does not need `node_modules`.
- Re-exports through barrel files are not followed, so a component that imports `./index` depends on the folder of the index, not the module it re-exports.
- Package `exports` maps are not interpreted; an import of `@scope/pkg/sub` counts as a dependency on `@scope/pkg`, which is what the rules need.
