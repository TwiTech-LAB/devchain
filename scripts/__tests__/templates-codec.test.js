const fs = require("fs");
const path = require("path");

const {
  FILE_POINTER_KEY,
  MAX_FILENAME_BYTES,
  composeTemplate,
  decomposeTemplate,
} = require("../templates/codec.js");

function createTemplate() {
  return {
    version: 2,
    exportedAt: "2026-08-25T00:00:00.000Z",
    prompts: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Review / ship safely",
        content: "Unicode: café 🚀\rline two\r\ntrailing spaces  \n",
        tags: [],
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        title: "Missing content",
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        title: "Empty content",
        content: "",
      },
    ],
    profiles: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Coder: senior?",
        provider: { id: "codex", name: "Codex" },
        instructions: "Keep the final newline.\n",
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        name: "No instructions",
        provider: { id: "codex", name: "Codex" },
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        name: "Null instructions",
        provider: { id: "codex", name: "Codex" },
        instructions: null,
      },
    ],
    agents: [],
  };
}

function pointer(path) {
  return { [FILE_POINTER_KEY]: path };
}

describe("strict template source codec", () => {
  it("decomposes only present prose strings without normalizing their bytes or structure", () => {
    const raw = createTemplate();
    const validate = jest.fn(() => ({ ...raw, transformed: true }));

    const source = decomposeTemplate(raw, validate);

    expect(validate).toHaveBeenCalledWith(raw);
    expect(source.template).not.toBe(raw);
    expect(Object.keys(source.template)).toEqual(Object.keys(raw));
    expect(Object.keys(source.template.prompts[0])).toEqual(
      Object.keys(raw.prompts[0]),
    );
    expect(source.template.prompts[0].content).toEqual(
      pointer("prompts/001-review-ship-safely.md"),
    );
    expect(source.template.prompts[1]).not.toHaveProperty("content");
    expect(source.template.prompts[2].content).toEqual(
      pointer("prompts/003-empty-content.md"),
    );
    expect(source.template.profiles[0].instructions).toEqual(
      pointer("profiles/001-coder-senior.md"),
    );
    expect(source.template.profiles[1]).not.toHaveProperty("instructions");
    expect(source.template.profiles[2].instructions).toBeNull();
    expect(source.files).toEqual({
      "prompts/001-review-ship-safely.md": raw.prompts[0].content,
      "prompts/003-empty-content.md": "",
      "profiles/001-coder-senior.md": raw.profiles[0].instructions,
    });
    expect(raw.prompts[0].content).toBe(
      "Unicode: café 🚀\rline two\r\ntrailing spaces  \n",
    );
  });

  it("round-trips deterministically and ignores transformed validator output", () => {
    const raw = createTemplate();
    const source = decomposeTemplate(raw, () => ({
      replaced: "during validation",
    }));
    const validate = jest.fn(() => ({ replaced: "during validation" }));

    const assembled = composeTemplate(source.template, source.files, validate);

    expect(assembled).toEqual(raw);
    expect(assembled).not.toBe(raw);
    expect(Object.keys(assembled)).toEqual(Object.keys(raw));
    expect(validate).toHaveBeenCalledWith(assembled);
    expect(assembled).not.toHaveProperty("replaced");
    expect(decomposeTemplate(assembled, () => undefined)).toEqual(source);
  });

  it("creates deterministic, path-safe, byte-bounded, collision-safe indexed filenames", () => {
    const repeatedUnsafeTitle = `../../CON \\ 😀 ${"é".repeat(300)}`;
    const raw = {
      prompts: [
        { title: repeatedUnsafeTitle, content: "one" },
        { title: repeatedUnsafeTitle, content: "two" },
        { title: "東京", content: "three" },
      ],
      profiles: [],
    };

    const source = decomposeTemplate(raw, () => undefined);
    const paths = Object.keys(source.files);

    expect(paths).toHaveLength(3);
    expect(new Set(paths).size).toBe(3);
    expect(paths[0]).toMatch(/^prompts\/001-[a-z0-9-]+\.md$/);
    expect(paths[1]).toMatch(/^prompts\/002-[a-z0-9-]+\.md$/);
    expect(paths[2]).toBe("prompts/003-item.md");
    for (const path of paths) {
      expect(path).not.toContain("..");
      expect(
        Buffer.byteLength(path.split("/").at(-1), "utf8"),
      ).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
    }
  });

  it.each([
    [
      "prompt content",
      (source) => (source.template.prompts[0].content = "inline"),
    ],
    [
      "profile instructions",
      (source) => (source.template.profiles[0].instructions = "inline"),
    ],
  ])("rejects inline strings at externalized %s paths", (_label, mutate) => {
    const source = decomposeTemplate(createTemplate(), () => undefined);
    mutate(source);

    expect(() =>
      composeTemplate(source.template, source.files, () => undefined),
    ).toThrow(/inline strings are not allowed/);
  });

  it("rejects missing files with the value path and referenced file path", () => {
    const source = decomposeTemplate(createTemplate(), () => undefined);
    delete source.files["prompts/001-review-ship-safely.md"];

    expect(() =>
      composeTemplate(source.template, source.files, () => undefined),
    ).toThrow(
      'prompts[0].content: missing file "prompts/001-review-ship-safely.md"',
    );
  });

  it("rejects duplicate file references", () => {
    const source = decomposeTemplate(createTemplate(), () => undefined);
    source.template.prompts[2].content = pointer(
      "prompts/001-review-ship-safely.md",
    );

    expect(() =>
      composeTemplate(source.template, source.files, () => undefined),
    ).toThrow(
      'prompts[2].content: duplicate file reference "prompts/001-review-ship-safely.md"',
    );
  });

  it("rejects orphan files", () => {
    const source = decomposeTemplate(createTemplate(), () => undefined);
    source.files["prompts/999-orphan.md"] = "orphan";

    expect(() =>
      composeTemplate(source.template, source.files, () => undefined),
    ).toThrow('files["prompts/999-orphan.md"]: orphan file');
  });

  it.each([
    ["an escaping path", pointer("../outside.md"), /must not escape/],
    ["an absolute path", pointer("/tmp/outside.md"), /must be relative/],
    ["a backslash path", pointer("prompts\\001-file.md"), /forward slashes/],
    [
      "a pointer with extra keys",
      { $file: "prompts/001-review-ship-safely.md", extra: true },
      /exactly one/,
    ],
    ["a non-string pointer", { $file: 42 }, /must be a string/],
    ["a non-canonical path", pointer("prompts/001-other.md"), /canonical file/],
  ])("rejects malformed pointer: %s", (_label, value, expected) => {
    const source = decomposeTemplate(createTemplate(), () => undefined);
    source.template.prompts[0].content = value;

    expect(() =>
      composeTemplate(source.template, source.files, () => undefined),
    ).toThrow(expected);
  });

  it("rejects malformed and non-string file entries before assembly", () => {
    const source = decomposeTemplate(createTemplate(), () => undefined);
    source.files["../outside.md"] = "bad";

    expect(() =>
      composeTemplate(source.template, source.files, () => undefined),
    ).toThrow('files["../outside.md"]: path must not escape the source root');

    delete source.files["../outside.md"];
    source.files["prompts/001-review-ship-safely.md"] = Buffer.from("bad");
    expect(() =>
      composeTemplate(source.template, source.files, () => undefined),
    ).toThrow(
      'files["prompts/001-review-ship-safely.md"]: content must be a string',
    );
  });

  it("preserves absent schema fields instead of emitting validator defaults", () => {
    const source = { template: { _manifest: { name: "Minimal" } }, files: {} };
    const validate = jest.fn(() => ({ version: 1, prompts: [], profiles: [] }));

    const assembled = composeTemplate(source.template, source.files, validate);

    expect(assembled).toEqual(source.template);
    expect(assembled).not.toHaveProperty("prompts");
    expect(assembled).not.toHaveProperty("profiles");
  });

  it("propagates schema validation failures after resolving every file pointer", () => {
    const source = decomposeTemplate(createTemplate(), () => undefined);
    const validate = jest.fn((assembled) => {
      expect(typeof assembled.prompts[0].content).toBe("string");
      expect(typeof assembled.profiles[0].instructions).toBe("string");
      throw new Error("ExportSchema rejected assembled template");
    });

    expect(() =>
      composeTemplate(source.template, source.files, validate),
    ).toThrow("ExportSchema rejected assembled template");
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("round-trips the bundled teams-dev template byte-for-byte without writing it", () => {
    const templatePath = path.resolve(
      __dirname,
      "../../apps/local-app/templates/teams-dev.json",
    );
    const originalJson = fs.readFileSync(templatePath, "utf8");
    const raw = JSON.parse(originalJson);
    const validate = (value) => {
      if (
        !value ||
        !Array.isArray(value.prompts) ||
        !Array.isArray(value.profiles)
      ) {
        throw new Error("invalid export fixture");
      }
    };

    const source = decomposeTemplate(raw, validate);
    const assembled = composeTemplate(source.template, source.files, validate);

    expect(JSON.stringify(assembled, null, 2)).toBe(originalJson);
    expect(Object.keys(source.files)).toHaveLength(
      raw.prompts.length + raw.profiles.length,
    );
  });
});
