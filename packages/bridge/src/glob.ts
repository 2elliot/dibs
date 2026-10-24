/** `src/auth/**` style globs from fixture/dibs.json. `**` crosses directories; `*` stays inside one. */
export function matchGlob(glob: string, file: string): boolean {
  const pattern = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  const target = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return toRegExp(pattern).test(target);
}

export function filesOutsideArea(
  files: string[],
  globs: string[],
  frozen: string[],
): string[] {
  const frozenSet = new Set(frozen.map((file) => file.replaceAll("\\", "/")));
  return files.filter((file) => {
    const name = file.replaceAll("\\", "/");
    if (frozenSet.has(name)) return true;
    if (globs.length === 0) return true;
    return !globs.some((glob) => matchGlob(glob, name));
  });
}

function toRegExp(glob: string): RegExp {
  let source = "^";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") i += 1;
      source += ".*";
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    source += /[.+^${}()|[\]\\]/.test(char ?? "") ? `\\${char}` : char;
  }
  return new RegExp(`${source}$`);
}
