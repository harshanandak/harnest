const ARRAY_FIELDS = ["evidence", "artifacts", "files", "tests", "risks"];
const MAX_FINAL_CHARS = 64_000;
const MAX_SUMMARY_CHARS = 16_000;
const MAX_ARRAY_ITEMS = 100;
const MAX_ITEM_CHARS = 4_000;

function stringArray(value) {
  return Array.isArray(value)
    ? value
      .filter((item) => typeof item === "string" && item.trim())
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => compactText(item.trim(), MAX_ITEM_CHARS))
    : [];
}

function parseCompletionObject(text) {
  if (!text.includes('"finalText"')) return null;
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const candidate = JSON.parse(text);
      if (Object.hasOwn(candidate, "finalText")) return candidate;
    } catch { /* A preamble or malformed output needs the fragment scanner. */ }
  }
  const stack = [];
  const candidates = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") stack.push({ start: index, marker: -1 });
    else if (char === "}" && stack.length) {
      const frame = stack.pop();
      if (frame.marker >= 0) {
        candidates.push({ ...frame, end: index + 1 });
        if (candidates.length > 256) candidates.shift();
      }
    } else if (char === '"' && stack.length) {
      const start = index;
      for (index += 1; index < text.length; index += 1) {
        if (text[index] === "\\") index += 1;
        else if (text[index] === '"') break;
      }
      if (text.slice(start, index + 1) === '"finalText"') {
        let next = index + 1;
        while (/\s/.test(text[next] || "") && next < text.length) next += 1;
        if (text[next] === ":") stack.at(-1).marker = start;
      }
    }
  }
  // Nested malformed objects must not cause every brace pair to be parsed.
  // Scan once, then cap both candidate count and aggregate parse work.
  let remainingChars = text.length * 2;
  candidates.sort((left, right) => right.marker - left.marker || right.start - left.start);
  for (const { start, end } of candidates) {
    const length = end - start;
    if (length > remainingChars) continue;
    remainingChars -= length;
    try {
      const candidate = JSON.parse(text.slice(start, end));
      if (Object.hasOwn(candidate, "finalText")) return candidate;
    } catch { /* Preserve plain-text compatibility when no envelope is valid. */ }
  }
  return null;
}

export function compactText(value, maxChars = 8_000) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

export function summarizeEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const types = [];
  for (const item of list) {
    const type = item?.type ?? item?.event?.type ?? item?.event?.event?.type;
    if (typeof type === "string" && !types.includes(type)) types.push(type);
  }
  return { count: list.length, types: types.slice(-20) };
}

export function structuredResult(value, extras = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  const parsed = parseCompletionObject(text);

  const rawFinalText = typeof parsed?.finalText === "string" && parsed.finalText.trim()
    ? parsed.finalText.trim()
    : text;
  const finalText = compactText(rawFinalText, MAX_FINAL_CHARS);
  const rawSummary = typeof parsed?.summary === "string" && parsed.summary.trim()
    ? parsed.summary.trim()
    : finalText;
  const result = {
    ...extras,
    finalText,
    summary: compactText(rawSummary, MAX_SUMMARY_CHARS),
    evidence: stringArray(parsed?.evidence),
    tests: stringArray(parsed?.tests),
    risks: stringArray(parsed?.risks),
  };
  for (const field of ARRAY_FIELDS.slice(1, 3)) {
    const items = stringArray(parsed?.[field]);
    if (items.length) result[field] = items;
  }
  return result;
}
