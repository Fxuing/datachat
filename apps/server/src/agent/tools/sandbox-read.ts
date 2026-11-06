import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  createReadToolDefinition,
  type ReadOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolContext } from "./context.js";

const ACCESS_DENIED = "EACCES";

function accessDenied(requested: string): NodeJS.ErrnoException {
  const error = new Error(
    `EACCES: 只允许读取技能目录内的文件，已拒绝: ${requested}`,
  ) as NodeJS.ErrnoException;
  error.code = ACCESS_DENIED;
  return error;
}

/**
 * Filesystem operations for the built-in read tool that are confined to one
 * directory. Both the lexical path and its realpath must stay inside the root,
 * so `..`, absolute paths elsewhere, and symlinks pointing outside all fail.
 */
export function createSandboxReadOperations(rootDir: string): ReadOperations {
  const root = path.resolve(rootDir);
  let realRootPromise: Promise<string> | undefined;

  const getRealRoot = (): Promise<string> => {
    realRootPromise ??= realpath(root);
    return realRootPromise;
  };

  const assertInside = async (candidate: string): Promise<string> => {
    const absolute = path.resolve(candidate);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw accessDenied(candidate);
    }
    const real = await realpath(absolute);
    const realRoot = await getRealRoot();
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw accessDenied(candidate);
    }
    return real;
  };

  return {
    async readFile(absolutePath) {
      return readFile(await assertInside(absolutePath));
    },
    async access(absolutePath) {
      await access(await assertInside(absolutePath), constants.R_OK);
    },
  };
}

export function createSandboxReadTool(ctx: AgentToolContext): ToolDefinition {
  return createReadToolDefinition(ctx.skillsDir, {
    operations: createSandboxReadOperations(ctx.skillsDir),
  }) as ToolDefinition;
}
