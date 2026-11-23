import { dataRoot } from "./control.ts";
import { controlFilePath, EndpointError, type Endpoint, fromControlFile } from "./browse/endpoint.ts";
import { envSet, expandUser, join, LINUX, purePath } from "./paths.ts";

export { controlFilePath, dataRoot, EndpointError };

export function chromiumDir(root: string): string {
  return LINUX ? root : join(root, "Chromium");
}

export function explicitDataRoot(dataDir: string | undefined): string | null {
  const root = dataDir || envSet("ARDIA_DATA_DIR");
  return root ? purePath(expandUser(root)) : null;
}

export function requireControl(root: string): Endpoint {
  return fromControlFile(controlFilePath(root));
}
