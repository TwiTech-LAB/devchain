"use strict";

const FILE_POINTER_KEY = "$file";
const MAX_FILENAME_BYTES = 120;
const SOURCE_FILE_PATTERN =
  /^(prompts|profiles)\/[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const PROSE_FIELD_POLICIES = [
  { collection: "prompts", field: "content", labelField: "title" },
  { collection: "profiles", field: "instructions", labelField: "name" },
];

class TemplateSourceError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "TemplateSourceError";
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isPlainObject(value)) return value;

  const clone = {};
  for (const key of Object.keys(value)) clone[key] = cloneValue(value[key]);
  return clone;
}

function requireValidator(validate) {
  if (typeof validate !== "function") {
    throw new TypeError("validate must be a function");
  }
}

function validateRawTemplate(rawTemplate, validate) {
  requireValidator(validate);
  validate(rawTemplate);
}

function safeStem(label) {
  const stem = String(label ?? "")
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "item";
}

function sourceFilePath(kind, index, label) {
  const indexPart = String(index + 1).padStart(3, "0");
  const maxStemBytes =
    MAX_FILENAME_BYTES - Buffer.byteLength(`${indexPart}-.md`, "utf8");
  if (maxStemBytes < 1) {
    throw new TemplateSourceError(
      `${kind}[${index}]`,
      "index is too large for a source filename",
    );
  }

  let stem = safeStem(label).slice(0, maxStemBytes).replace(/-+$/g, "");
  if (!stem) stem = "item".slice(0, maxStemBytes);
  return `${kind}/${indexPart}-${stem}.md`;
}

function replaceStringsWithPointers(items, policy, files) {
  if (!Array.isArray(items)) return;

  const { collection, field, labelField } = policy;

  items.forEach((item, index) => {
    if (
      !isPlainObject(item) ||
      !Object.prototype.hasOwnProperty.call(item, field)
    )
      return;
    if (typeof item[field] !== "string") return;

    const path = sourceFilePath(collection, index, item[labelField]);
    files[path] = item[field];
    item[field] = { [FILE_POINTER_KEY]: path };
  });
}

function decomposeTemplate(rawTemplate, validate) {
  validateRawTemplate(rawTemplate, validate);

  const template = cloneValue(rawTemplate);
  const files = {};
  if (isPlainObject(template)) {
    for (const policy of PROSE_FIELD_POLICIES) {
      replaceStringsWithPointers(template[policy.collection], policy, files);
    }
  }

  return { template, files };
}

function validateSourceFilePath(path, valuePath) {
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    throw new TemplateSourceError(valuePath, "file path must be relative");
  }
  if (path.includes("\\")) {
    throw new TemplateSourceError(
      valuePath,
      "file path must use forward slashes",
    );
  }

  const segments = path.split("/");
  if (segments.includes("..")) {
    throw new TemplateSourceError(
      valuePath,
      "path must not escape the source root",
    );
  }
  if (!SOURCE_FILE_PATTERN.test(path)) {
    throw new TemplateSourceError(
      valuePath,
      "file path is not a canonical template prose path",
    );
  }
  if (Buffer.byteLength(segments.at(-1), "utf8") > MAX_FILENAME_BYTES) {
    throw new TemplateSourceError(
      valuePath,
      `filename exceeds ${MAX_FILENAME_BYTES} bytes`,
    );
  }
}

function validateFiles(files) {
  if (!isPlainObject(files)) {
    throw new TemplateSourceError(
      "files",
      "must be an object keyed by source-relative path",
    );
  }

  for (const [path, content] of Object.entries(files)) {
    const valuePath = `files[${JSON.stringify(path)}]`;
    validateSourceFilePath(path, valuePath);
    if (typeof content !== "string") {
      throw new TemplateSourceError(valuePath, "content must be a string");
    }
  }
}

function readPointer(value, valuePath) {
  if (typeof value === "string") {
    throw new TemplateSourceError(
      valuePath,
      "inline strings are not allowed; use a file pointer",
    );
  }
  if (!isPlainObject(value)) {
    throw new TemplateSourceError(valuePath, "must be a file pointer");
  }

  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== FILE_POINTER_KEY) {
    throw new TemplateSourceError(
      valuePath,
      `file pointer must contain exactly one ${JSON.stringify(FILE_POINTER_KEY)} key`,
    );
  }
  if (typeof value[FILE_POINTER_KEY] !== "string") {
    throw new TemplateSourceError(
      valuePath,
      `${FILE_POINTER_KEY} must be a string`,
    );
  }

  const path = value[FILE_POINTER_KEY];
  validateSourceFilePath(path, valuePath);
  return path;
}

function restorePointers(items, policy, files, referencedFiles) {
  if (!Array.isArray(items)) return;

  const { collection, field, labelField } = policy;

  items.forEach((item, index) => {
    if (
      !isPlainObject(item) ||
      !Object.prototype.hasOwnProperty.call(item, field)
    )
      return;
    const value = item[field];
    if (value === null || value === undefined) return;

    const valuePath = `${collection}[${index}].${field}`;
    const path = readPointer(value, valuePath);
    if (referencedFiles.has(path)) {
      throw new TemplateSourceError(
        valuePath,
        `duplicate file reference ${JSON.stringify(path)}`,
      );
    }

    const expectedPath = sourceFilePath(collection, index, item[labelField]);
    if (path !== expectedPath) {
      throw new TemplateSourceError(
        valuePath,
        `expected canonical file ${JSON.stringify(expectedPath)}, received ${JSON.stringify(path)}`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(files, path)) {
      throw new TemplateSourceError(
        valuePath,
        `missing file ${JSON.stringify(path)}`,
      );
    }

    referencedFiles.add(path);
    item[field] = files[path];
  });
}

function composeTemplate(sourceTemplate, files, validate) {
  requireValidator(validate);
  validateFiles(files);

  const assembled = cloneValue(sourceTemplate);
  const referencedFiles = new Set();
  if (isPlainObject(assembled)) {
    for (const policy of PROSE_FIELD_POLICIES) {
      restorePointers(
        assembled[policy.collection],
        policy,
        files,
        referencedFiles,
      );
    }
  }

  for (const path of Object.keys(files)) {
    if (!referencedFiles.has(path)) {
      throw new TemplateSourceError(
        `files[${JSON.stringify(path)}]`,
        "orphan file",
      );
    }
  }

  validateRawTemplate(assembled, validate);
  return assembled;
}

module.exports = {
  FILE_POINTER_KEY,
  MAX_FILENAME_BYTES,
  TemplateSourceError,
  composeTemplate,
  decomposeTemplate,
};
