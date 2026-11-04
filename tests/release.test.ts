// ABOUTME: Tests for the production release script: versions, arguments and git steps.
// ABOUTME: Git is replaced by a recorder, so no test touches the repository.

import {
  parseVersion,
  calculateNextVersion,
  ParsedVersion,
  buildGitHubReleaseCreateArgs,
  buildReleaseTagCommands,
  parseReleaseArgs,
  commitAndPush,
} from "../scripts/release";

describe("parseVersion", () => {
  test("parses production version", () => {
    const result = parseVersion("1.0.2");
    expect(result).toEqual({
      major: 1,
      minor: 0,
      patch: 2,
    });
  });

  test("parses version with larger numbers", () => {
    const result = parseVersion("12.34.56");
    expect(result).toEqual({
      major: 12,
      minor: 34,
      patch: 56,
    });
  });

  test("returns null for invalid version", () => {
    expect(parseVersion("invalid")).toBeNull();
    expect(parseVersion("1.0")).toBeNull();
    expect(parseVersion("1.0.0.0")).toBeNull();
    expect(parseVersion("v1.0.0")).toBeNull();
  });

  test("returns null for beta version", () => {
    expect(parseVersion("1.0.0-beta.1")).toBeNull();
  });
});

describe("calculateNextVersion", () => {
  const current: ParsedVersion = { major: 1, minor: 2, patch: 3 };

  test("calculates patch bump", () => {
    expect(calculateNextVersion(current, "patch")).toBe("1.2.4");
  });

  test("calculates minor bump", () => {
    expect(calculateNextVersion(current, "minor")).toBe("1.3.0");
  });

  test("calculates major bump", () => {
    expect(calculateNextVersion(current, "major")).toBe("2.0.0");
  });

  test("accepts valid custom version", () => {
    expect(calculateNextVersion(current, "5.0.0")).toBe("5.0.0");
  });

  test("throws for invalid custom version", () => {
    expect(() => calculateNextVersion(current, "invalid")).toThrow("Invalid version format");
  });

  test("throws for beta custom version", () => {
    expect(() => calculateNextVersion(current, "1.0.0-beta.1")).toThrow("Invalid version format");
  });

  test("throws for unknown string that is not valid version", () => {
    expect(() => calculateNextVersion(current, "auto")).toThrow("Invalid version format");
  });
});

describe("buildGitHubReleaseCreateArgs", () => {
  test("creates a draft release without local asset uploads", () => {
    const args = buildGitHubReleaseCreateArgs("1.3.2", "/tmp/notes.md");

    expect(args).toEqual([
      "release",
      "create",
      "1.3.2",
      "--title",
      "v1.3.2",
      "--notes-file",
      "/tmp/notes.md",
      "--draft",
    ]);
    expect(args).not.toContain("main.js");
    expect(args).not.toContain("styles.css");
    expect(args).not.toContain("manifest.json");
  });
});

describe("buildReleaseTagCommands", () => {
  test("tags the release commit and pushes only that tag", () => {
    expect(buildReleaseTagCommands("1.3.12")).toEqual([
      ["tag", "1.3.12"],
      ["push", "origin", "1.3.12"],
    ]);
  });
});

describe("parseReleaseArgs", () => {
  test("returns no options when run interactively", () => {
    expect(parseReleaseArgs([])).toEqual({});
  });

  test("reads an approved version and notes file", () => {
    expect(parseReleaseArgs(["--version", "1.3.13", "--notes-file", "/tmp/notes.md"])).toEqual({
      version: "1.3.13",
      notesFile: "/tmp/notes.md",
    });
  });

  test("rejects an option without a value", () => {
    expect(() => parseReleaseArgs(["--version"])).toThrow("--version needs a value");
  });

  test("rejects unknown options", () => {
    expect(() => parseReleaseArgs(["--yes"])).toThrow("Unknown option: --yes");
  });
});

describe("commitAndPush", () => {
  const files = ["package.json", "manifest.json", "versions.json"];

  /** Records each git call and answers with the status given for its first argument. */
  function fakeGit(statuses: Record<string, number> = {}) {
    const calls: string[][] = [];
    const git = (args: string[]) => {
      calls.push(args);
      return statuses[args[0]] ?? 0;
    };
    return { git, calls };
  }

  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("commits the version files and pushes", () => {
    const { git, calls } = fakeGit({ diff: 1 });
    expect(commitAndPush("0.1.0", git)).toBe(true);
    expect(calls).toEqual([
      ["add", ...files],
      ["diff", "--cached", "--quiet", "--", ...files],
      ["commit", "-m", "Release v0.1.0"],
      ["push"],
    ]);
  });

  it("skips the commit when the version files already hold the version, and still pushes", () => {
    const { git, calls } = fakeGit({ diff: 0 });
    expect(commitAndPush("0.1.0", git)).toBe(true);
    expect(calls).toEqual([
      ["add", ...files],
      ["diff", "--cached", "--quiet", "--", ...files],
      ["push"],
    ]);
    expect(console.log).toHaveBeenCalledWith(
      "Version files already say 0.1.0; nothing to commit, so skipping the commit"
    );
  });

  it.each([
    ["add", { add: 128 }],
    ["diff", { diff: 128 }],
    ["commit", { diff: 1, commit: 1 }],
    ["push", { diff: 1, push: 1 }],
  ])("stops when git %s fails", (step, statuses) => {
    const { git, calls } = fakeGit(statuses);
    expect(commitAndPush("0.1.0", git)).toBe(false);
    expect(calls[calls.length - 1][0]).toBe(step);
    expect(console.error).toHaveBeenCalledWith(`\nError during git operations: git ${step} failed`);
  });
});
