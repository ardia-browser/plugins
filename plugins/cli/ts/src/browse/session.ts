import { constants as fsConstants, lstatSync, type Stats } from "node:fs";
import { constants } from "node:os";
import { codeOf, errnoOf, join, uid } from "../paths.ts";
import { close, type Dir, O_RDONLY, openPrivate, openPrivateFile, PathError } from "../privatefs.ts";
import { BrowseError, PythonCrash } from "./errors.ts";
import { osCrash } from "../crash.ts";
import { pythonOsError } from "../printable.ts";
import { flock, socketInfoAt, strerror } from "../libc.ts";

export const DIR_NAME = "Browse";
const { ELOOP, ENOTDIR, ENOENT } = constants.errno;
const { S_IFMT, S_IFSOCK } = fsConstants;

export class NoDaemon extends Error {}

export function osFailure(error: unknown): PythonCrash {
  const errno = errnoOf(error);
  return new PythonCrash(osCrash(errno), `${pythonOsError(errno)}: [Errno ${errno}] ${strerror(errno)}`);
}

function rootRefusal(root: string): BrowseError | undefined {
  let info: Stats;
  try {
    info = lstatSync(root);
  } catch (error) {
    if (errnoOf(error) === ENOENT) return new BrowseError(`${root} doesn't exist`, 1, undefined, "unsafe_path");
    if (errnoOf(error) === ENOTDIR) return new BrowseError(`${root} is a symbolic link or not a folder`, 1, undefined, "unsafe_path");
    throw osFailure(error);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return new BrowseError(`${root} is a symbolic link or not a folder`, 1, undefined, "unsafe_path");
  if (info.uid !== uid()) return new BrowseError(`${root} belongs to another user`, 1, undefined, "unsafe_path");
  return undefined;
}

function browseRefusal(root: string): BrowseError | undefined {
  let info: Stats;
  try {
    info = lstatSync(join(root, DIR_NAME));
  } catch (error) {
    if (errnoOf(error) === ELOOP || errnoOf(error) === ENOTDIR) return new BrowseError(`${DIR_NAME} is a symbolic link or not a folder`, 1, undefined, "unsafe_path");
    throw osFailure(error);
  }
  if (info.isSymbolicLink()) return new BrowseError(`${DIR_NAME} is a symbolic link or not a folder`, 1, undefined, "unsafe_path");
  if (!info.isDirectory()) return new BrowseError(`${DIR_NAME} is a symbolic link or not a folder`, 1, undefined, "unsafe_path");
  if (info.uid !== uid()) return new BrowseError(`${DIR_NAME} belongs to another user`, 1, undefined, "unsafe_path");
  if ((info.mode & 0o077) !== 0) return new BrowseError(`${DIR_NAME} must be private (mode 0700)`, 1, undefined, "unsafe_path");
  return undefined;
}

export function openBrowseDir(root: string): Dir {
  try {
    return openPrivate(root, [DIR_NAME], true);
  } catch (error) {
    if (!(error instanceof PathError)) {
      if (codeOf(error) === "ENOENT") throw new BrowseError(`${root} doesn't exist`, 1, undefined, "unsafe_path");
      throw osFailure(error);
    }
    throw rootRefusal(root) ?? browseRefusal(root) ?? new BrowseError(`${root} is a symbolic link or not a folder`, 1, undefined, "unsafe_path");
  }
}

export function checkSocket(dir: Dir, name: string): void {
  let info: { mode: number; uid: number };
  try {
    info = socketInfoAt(dir.fd, name);
  } catch (error) {
    if (errnoOf(error) === ENOENT) throw new NoDaemon("no socket");
    throw osFailure(error);
  }
  let why: string | undefined;
  if ((info.mode & S_IFMT) !== S_IFSOCK) why = `${name} isn't a socket`;
  else if (info.uid !== uid()) why = `${name} belongs to another user`;
  else if ((info.mode & 0o077) !== 0) why = `${name} must be mode 0600`;
  if (why !== undefined) throw new BrowseError(`Refusing the session socket: ${why}`, 1, undefined, "socket_refused");
}

export function lockHeld(dir: Dir, key: string): boolean {
  let fd: number;
  try {
    fd = openPrivateFile(`${key}.lock`, dir, O_RDONLY);
  } catch {
    return false;
  }
  try {
    return !flock(fd, false, false);
  } finally {
    close(fd);
  }
}
