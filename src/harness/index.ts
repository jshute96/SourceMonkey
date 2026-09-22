// Public entry point of the development harness: what another repo
// gets from `import … from 'sourcemonkey/harness'`. See
// docs/harness-guide.md for the user-facing description and
// docs/harness-design.md for the design.

export {
  prepareScript,
  explainMatch,
  type PrepareOptions,
  type PreparedScript,
  type MatchExplanation,
  type InjectionWorld,
  type RunAt,
  type RegistrationEntries,
} from './prepare.js';
export type { StoredScript, ScriptMatching, StartupLog } from '../script-store.js';
export type { DiagnosticLocation } from '../diagnostic-location.js';
export type { ApiSubsystem } from '../gm-api-catalog.js';
export { checkParseNode } from './parse-check-node.js';
export {
  HarnessHost,
  type PageLink,
  type HostReports,
  type HostEventMap,
  type StartReport,
  type ErrorReport,
  type SkipReport,
  type LogReport,
} from './host.js';
export { attachPage, PageAttachment, type InjectOptions } from './inject.js';
