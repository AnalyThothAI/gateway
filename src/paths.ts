/**
 * Returns the project root path.
 *
 * Gateway expects to be started from the project root, so `process.cwd()` is a
 * reliable root path across dev, tests, and production containers.
 */
export function rootPath(): string {
  return process.cwd();
}
