import { constants, realpathSync, statSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";

export const MAX_ADD_DIRS = 8;
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_INSTRUCTIONS_BYTES = 8_000;
export const EXECUTION_CONTROLS = ["addDirs", "attachments", "instructions", "sessionAction", "maxTurns"];

const targets = {
  addDirs: ["claude", "codex", "cursor"],
  attachments: ["codex", "opencode", "pi", "acp"],
  instructions: ["claude", "pi"],
  sessionAction: ["claude", "codex", "opencode", "pi"],
  maxTurns: ["claude"],
};

export function executionError(field, reason) {
  const name = `execution.${field}`;
  return Object.assign(new TypeError(`${name} ${reason}`), { details: { kind: "validation", field: name } });
}

function canonicalPath(path, field, directory) {
  if (typeof path !== "string" || path.length > 1024 || path.includes("\0") || !isAbsolute(path)
      || (process.platform === "win32" && !/^(?:[a-z]:[\\/]|\\\\[^?.\\][^\\]*\\)/i.test(path))) {
    throw executionError(field, "requires fully qualified absolute paths of at most 1024 characters");
  }
  let resolved, info;
  try {
    resolved = realpathSync.native(path);
    info = statSync(resolved);
  } catch {
    throw executionError(field, `requires an existing ${directory ? "directory" : "file"}`);
  }
  if (directory ? !info.isDirectory() : !info.isFile()) {
    throw executionError(field, `requires an existing ${directory ? "directory" : "regular file"}`);
  }
  if (!directory && info.size > MAX_ATTACHMENT_BYTES) {
    throw executionError(field, `files must be at most ${MAX_ATTACHMENT_BYTES} bytes each`);
  }
  return resolved;
}

function boundedArray(value, field, limit) {
  if (!Array.isArray(value) || value.length > limit) throw executionError(field, `must be an array of at most ${limit} items`);
  return value;
}

const imageTypes = new Map([
  [".png", "image/png"], [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"],
]);
export const attachmentMimeType = (path) => imageTypes.get(extname(path).toLowerCase());

export function normalizeExecutionControls({ target, execution = {}, cwd, policy, metadata }) {
  execution ??= {};
  const controls = {};
  for (const field of EXECUTION_CONTROLS) {
    if (execution[field] === undefined) continue;
    if (field === "sessionAction" && execution[field] === "resume") continue;
    if (!targets[field].includes(target) || execution.transport === "session") {
      throw executionError(field, `is unsupported for ${target}${execution.transport === "session" ? " session transport" : ""}`);
    }
    controls[field] = execution[field];
  }

  if (execution.sessionAction !== undefined && !["resume", "fork"].includes(execution.sessionAction)) {
    throw executionError("sessionAction", "must be resume or fork");
  }
  if (execution.sessionAction !== undefined && (typeof execution.sessionId !== "string" || !execution.sessionId.trim() || execution.sessionId.startsWith("-") || execution.sessionId.includes("\0"))) {
    throw executionError("sessionAction", "requires an explicit sessionId");
  }
  if (controls.sessionAction === "fork" && target === "pi" && /[\\/:]/.test(execution.sessionId)) {
    throw executionError("sessionAction", "Pi fork requires a session ID");
  }
  if (controls.addDirs !== undefined) {
    controls.addDirs = boundedArray(controls.addDirs, "addDirs", MAX_ADD_DIRS).map((path) => canonicalPath(path, "addDirs", true));
    if (target === "codex" && controls.addDirs.length && policy?.write !== true) {
      throw executionError("addDirs", "Codex --add-dir grants write access and requires policy.write=true");
    }
    if (policy?.write === true && controls.addDirs.length && metadata?.harnest?.writeApproved !== true) {
      const root = canonicalPath(cwd, "addDirs", true);
      if (controls.addDirs.some((path) => {
        const fromRoot = relative(root, path);
        return isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`);
      })) throw executionError("addDirs", "external write roots require metadata.harnest.writeApproved=true");
    }
  }
  if (controls.attachments !== undefined) {
    controls.attachments = boundedArray(controls.attachments, "attachments", MAX_ATTACHMENTS).map((item) => {
      if (!item || !["image", "file"].includes(item.type) || Object.keys(item).some((key) => !["type", "path"].includes(key))) {
        throw executionError("attachments", "items must have an image or file type and a path");
      }
      if (item.type === "file" && (target === "codex" || target === "pi")) {
        throw executionError("attachments", `${target} supports only image inputs on this transport`);
      }
      const path = canonicalPath(item.path, "attachments", false);
      if (item.type === "image" && !attachmentMimeType(path)) {
        throw executionError("attachments", "images must use a PNG, JPEG, GIF, or WebP extension");
      }
      return { type: item.type, path };
    });
  }
  if (controls.instructions !== undefined && (typeof controls.instructions !== "string" || !controls.instructions.trim()
      || controls.instructions.includes("\0") || Buffer.byteLength(controls.instructions) > MAX_INSTRUCTIONS_BYTES)) {
    throw executionError("instructions", `must be nonempty text of at most ${MAX_INSTRUCTIONS_BYTES} UTF-8 bytes without NUL`);
  }
  if (controls.maxTurns !== undefined && (!Number.isSafeInteger(controls.maxTurns) || controls.maxTurns < 1)) {
    throw executionError("maxTurns", "must be a positive safe integer");
  }
  if (execution.sessionAction === "resume") controls.sessionAction = "resume";
  return controls;
}

export function validateAdapterExecution(request, target, transport) {
  if (!request || typeof request !== "object") throw new TypeError("request must be an object");
  const execution = request.execution ?? {};
  const controls = normalizeExecutionControls({ ...request, target, execution: { ...execution, transport: transport ?? execution.transport } });
  return { ...request, execution: { ...execution, ...controls } };
}

export async function readAttachment(path) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const file = await open(path, flags).catch(() => { throw executionError("attachments", "file could not be opened before launch"); });
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES) throw executionError("attachments", "file changed before launch");
    const buffer = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) return buffer.subarray(0, offset);
      offset += bytesRead;
    }
    throw executionError("attachments", "file exceeded its byte limit before launch");
  } finally {
    await file.close();
  }
}

export async function stageAttachments(attachments, directory) {
  const staged = [];
  for (const attachment of attachments ?? []) {
    const path = join(directory, `${staged.length}-${basename(attachment.path).replaceAll(",", "_")}`);
    if (path.includes(",")) throw executionError("attachments", "native CLI attachment paths cannot contain commas");
    await writeFile(path, await readAttachment(attachment.path), { mode: 0o600, flag: "wx" });
    staged.push({ ...attachment, path });
  }
  return staged;
}
