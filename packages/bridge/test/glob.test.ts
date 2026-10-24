import { describe, expect, it } from "vitest";
import { filesOutsideArea, matchGlob } from "../src/glob.ts";

describe("area globs", () => {
  it("matches fixture areas and counts frozen files as outside", () => {
    expect(matchGlob("src/auth/**", "src/auth/login.js")).toBe(true);
    expect(matchGlob("src/auth/**", "src/auth/nested/token.js")).toBe(true);
    expect(matchGlob("src/auth/**", "src/events/register.js")).toBe(false);
    expect(matchGlob("public/**", "public/app.js")).toBe(true);
    const outside = filesOutsideArea(
      ["src/auth/login.js", "notes.txt", "README.md"],
      ["src/auth/**"],
      ["README.md", "dibs.json"],
    );
    expect(outside).toEqual(["notes.txt", "README.md"]);
  });
});
