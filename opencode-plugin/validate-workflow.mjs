// Pure pre-flight validator for harnest_handoff_workflow arguments.
// Dependency-free so the installed V1 and V2 entrypoints share the same guard.
export const HANDOFF_WORKFLOW_TOOL = "harnest_handoff_workflow"

// Dependency-free absolute-path check (no node:path import): POSIX root,
// Windows drive root, or UNC prefix.
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/

function handoffRequestOf(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null
  if (Object.hasOwn(args, "request")) {
    const inner = args.request
    return inner && typeof inner === "object" && !Array.isArray(inner) ? inner : null
  }
  return args
}

// Returns an error message naming the offending field, or null when the
// arguments look sane. Never throws: unparseable input fails as a "request"
// problem, never as an exception.
export function validateHandoffWorkflowArgs(args) {
  let request = null
  try {
    request = handoffRequestOf(args)
  } catch {
    request = null
  }
  if (!request) {
    return `${HANDOFF_WORKFLOW_TOOL}: request is required and must be an object`
  }
  if (typeof request.requestId !== "string" || !request.requestId.trim()) {
    return `${HANDOFF_WORKFLOW_TOOL}: requestId is required and must not be blank`
  }
  if (typeof request.cwd !== "string" || !request.cwd.trim()) {
    return `${HANDOFF_WORKFLOW_TOOL}: cwd is required and must be an absolute path`
  }
  if (!ABSOLUTE_PATH.test(request.cwd.trim())) {
    return `${HANDOFF_WORKFLOW_TOOL}: cwd must be an absolute path, got ${JSON.stringify(request.cwd.slice(0, 80))}`
  }
  if (request.target === "opencode" && request.route?.model != null && typeof request.route.model !== "string") {
    return `${HANDOFF_WORKFLOW_TOOL}: route.model must be a string when provided`
  }
  return null
}
