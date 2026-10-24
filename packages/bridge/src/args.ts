export interface Args {
  rest: string[];
  get(name: string): string | undefined;
  has(name: string): boolean;
}

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) flags.set(body.slice(0, eq), body.slice(eq + 1));
    else if (i + 1 < argv.length && !(argv[i + 1] ?? "").startsWith("--"))
      flags.set(body, argv[++i] ?? "");
    else flags.set(body, true);
  }
  return {
    rest,
    get(name: string) {
      const value = flags.get(name);
      return typeof value === "string" ? value : undefined;
    },
    has(name: string) {
      return flags.has(name);
    },
  };
}
