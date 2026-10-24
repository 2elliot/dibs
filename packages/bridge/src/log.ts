export function log(message: string): void {
  process.stderr.write(
    `dibs-bridge: ${message.endsWith("\n") ? message : `${message}\n`}`,
  );
}
