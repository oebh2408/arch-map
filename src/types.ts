export type ContainerKind = 'web' | 'api' | 'worker' | 'cli' | 'library';

export interface PackageManifest {
  name?: string;
  description?: string;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  archMap?: { kind?: ContainerKind; technology?: string; description?: string; ignore?: boolean };
}

export interface WorkspacePackage {
  name: string;
  /** Directory relative to the repository root, posix style. */
  dir: string;
  manifest: PackageManifest;
  /** Source files relative to the repository root. */
  files: string[];
}

export interface ImportRef {
  /** File that contains the import, relative to the root. */
  from: string;
  specifier: string;
  line: number;
  /** Resolved file inside the same package, when the import is relative. */
  file?: string;
  /** Workspace package the import points at. */
  package?: string;
  /** Third-party package name, e.g. `pg` or `@scope/lib`. */
  external?: string;
}

export interface ExternalSystem {
  id: string;
  name: string;
  kind: 'database' | 'cache' | 'queue' | 'storage' | 'email' | 'api' | 'search';
  /** Packages that brought this system in. */
  via: string[];
}

export interface Container {
  name: string;
  dir: string;
  kind: ContainerKind;
  technology: string;
  description?: string;
  /** External systems this package uses directly. */
  externals: string[];
}

export interface PackageEdge {
  from: string;
  to: string;
  /** Number of import statements behind the edge. */
  imports: number;
  /** Listed in dependencies, devDependencies or peerDependencies. */
  declared: boolean;
  /** Only used by test files. */
  testOnly: boolean;
}

export interface Component {
  /** Folder inside the package, e.g. `src/routes`. */
  id: string;
  package: string;
  files: number;
  externals: string[];
}

export interface ComponentEdge {
  package: string;
  from: string;
  to: string;
  imports: number;
}

export interface ArchitectureModel {
  name: string;
  root: string;
  containers: Container[];
  edges: PackageEdge[];
  externals: ExternalSystem[];
  components: Component[];
  componentEdges: ComponentEdge[];
  imports: ImportRef[];
  /** Source file → package name. */
  fileOwners: Record<string, string>;
  /** Source file → component id inside its package. */
  fileComponents: Record<string, string>;
}

export type Severity = 'error' | 'warning';

export interface Violation {
  rule: string;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  from?: string;
  to?: string;
  /** For import-level violations: the file or workspace package that was imported. */
  target?: string;
}

export interface LayerConfig {
  name: string;
  /** Package directories or names, globs allowed. */
  packages: string[];
}

export interface ForbiddenRule {
  /** Glob over file paths relative to the root, or over package names when `packages` is true. */
  from: string;
  to: string;
  reason?: string;
}

export interface Config {
  /** Name of the system in the diagrams. Defaults to the root package name. */
  name?: string;
  /** Ordered from top (may depend on everything below) to bottom. */
  layers?: LayerConfig[];
  forbidden?: ForbiddenRule[];
  /** Folder depth inside each package used for component diagrams. Default 1 below src/. */
  componentDepth?: number;
  /** Extra mapping from third-party package to external system. */
  externals?: Record<string, { name: string; kind: ExternalSystem['kind'] }>;
  /** Files ignored entirely, globs relative to the root. */
  ignore?: string[];
  rules?: Partial<Record<'cycles' | 'undeclared-dependency' | 'unused-dependency' | 'layers' | 'forbidden', Severity | 'off'>>;
}
