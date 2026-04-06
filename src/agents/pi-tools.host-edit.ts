import os from "node:os";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { normalizeToolParams } from "./pi-tools.params.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

type EditToolRecoveryOptions = {
  root: string;
  readFile: (absolutePath: string) => Promise<string>;
};

type EditToolParams = {
  pathParam?: string;
  edits: EditReplacement[];
};

type EditReplacement = {
  oldText: string;
  newText: string;
};

const EDIT_MISMATCH_MESSAGE = "Could not find the exact text in";
const EDIT_MISMATCH_HINT_LIMIT = 800;

/** Resolve path for edit recovery: expand ~ and resolve relative paths against root. */
function resolveEditPath(root: string, pathParam: string): string {
  const expanded =
    pathParam.startsWith("~/") || pathParam === "~"
      ? pathParam.replace(/^~/, os.homedir())
      : pathParam;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}

function readStringParam(record: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function readEditReplacements(record: Record<string, unknown> | undefined): EditReplacement[] {
  if (!Array.isArray(record?.edits)) {
    return [];
  }
  return record.edits.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const replacement = entry as Record<string, unknown>;
    if (typeof replacement.oldText !== "string" || replacement.oldText.trim().length === 0) {
      return [];
    }
    if (typeof replacement.newText !== "string") {
      return [];
    }
    return [{ oldText: replacement.oldText, newText: replacement.newText }];
  });
}

function readEditToolParams(params: unknown): EditToolParams {
  const normalized = normalizeToolParams(params);
  const record =
    normalized ??
    (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
  return {
    pathParam: readStringParam(record, "path", "file_path", "filePath", "file"),
    edits: readEditReplacements(record),
  };
}

function normalizeToLF(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function didEditLikelyApply(params: {
  originalContent?: string;
  currentContent: string;
  edits: EditReplacement[];
}) {
  if (params.edits.length === 0) {
    return false;
  }
  const normalizedCurrent = normalizeToLF(params.currentContent);
  const normalizedOriginal =
    typeof params.originalContent === "string" ? normalizeToLF(params.originalContent) : undefined;

  // If we have the original content and it's identical to current, the edit
  // didn't change anything → not applied.
  if (normalizedOriginal !== undefined && normalizedOriginal === normalizedCurrent) {
    return false;
  }

  // All non-empty newText replacements must now exist in the current file.
  for (const edit of params.edits) {
    const normalizedNew = normalizeToLF(edit.newText);
    if (normalizedNew.length > 0 && !normalizedCurrent.includes(normalizedNew)) {
      return false;
    }
  }

  // If we have the original content, verify each oldText was actually removed
  // from its original position. We do this by counting occurrences of oldText
  // in the original vs current — if the edit applied, current should have
  // fewer occurrences (or the count went up but only because newText contains
  // oldText as a substring, in which case we trust the previous newText check).
  //
  // BUG FIX: The previous implementation removed all newText occurrences from
  // current and then checked if any oldText remained. This produced false
  // failures when oldText was a common identifier appearing multiple times in
  // the file (e.g., "spawnTimer" in waveManager.ts) — the depleted version
  // still contained legitimate other occurrences, causing the check to wrongly
  // report the edit as failed even when the file was correctly modified.
  //
  // The correct check: compare oldText counts in original vs current. The edit
  // applied iff (current count of oldText) <= (original count - 1) for at least
  // the oldText that was supposed to be replaced. Since newText may itself
  // contain oldText as a substring, we additionally allow current count to be
  // higher when newText contains oldText.
  if (normalizedOriginal !== undefined) {
    for (const edit of params.edits) {
      const normalizedOld = normalizeToLF(edit.oldText);
      if (normalizedOld.length === 0) {
        continue;
      }
      const normalizedNew = normalizeToLF(edit.newText);
      const originalCount = countOccurrences(normalizedOriginal, normalizedOld);
      const currentCount = countOccurrences(normalizedCurrent, normalizedOld);
      // newText may contain oldText as a substring; account for it.
      const newTextOldCount =
        normalizedNew.length > 0 ? countOccurrences(normalizedNew, normalizedOld) : 0;
      // If newText contains oldText, each newText insertion adds newTextOldCount
      // to the current count. Expected current count after a single replacement:
      //   original - 1 + newTextOldCount
      // Allow current count to be at most that value (multiple identical edits
      // could push it lower).
      const expectedMaxAfterReplace = originalCount - 1 + newTextOldCount;
      if (currentCount > expectedMaxAfterReplace) {
        return false;
      }
    }
    return true;
  }

  // Without original content, we can only verify newText is present (already
  // done above). Skip the oldText check since we can't reliably distinguish
  // legitimate other occurrences from a failed replacement.
  return true;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function buildEditSuccessResult(pathParam: string, editCount: number): AgentToolResult<unknown> {
  const text =
    editCount > 1
      ? `Successfully replaced ${editCount} block(s) in ${pathParam}.`
      : `Successfully replaced text in ${pathParam}.`;
  return {
    isError: false,
    content: [
      {
        type: "text",
        text,
      },
    ],
    details: { diff: "", firstChangedLine: undefined },
  } as AgentToolResult<unknown>;
}

function shouldAddMismatchHint(error: unknown) {
  return error instanceof Error && error.message.includes(EDIT_MISMATCH_MESSAGE);
}

function appendMismatchHint(error: Error, currentContent: string): Error {
  const snippet =
    currentContent.length <= EDIT_MISMATCH_HINT_LIMIT
      ? currentContent
      : `${currentContent.slice(0, EDIT_MISMATCH_HINT_LIMIT)}\n... (truncated)`;
  const enhanced = new Error(`${error.message}\nCurrent file contents:\n${snippet}`);
  enhanced.stack = error.stack;
  return enhanced;
}

/**
 * Recover from two edit-tool failure classes without changing edit semantics:
 * - exact-match mismatch errors become actionable by including current file contents
 * - post-write throws are converted back to success only if the file actually changed
 */
export function wrapEditToolWithRecovery(
  base: AnyAgentTool,
  options: EditToolRecoveryOptions,
): AnyAgentTool {
  return {
    ...base,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ) => {
      const { pathParam, edits } = readEditToolParams(params);
      const absolutePath =
        typeof pathParam === "string" ? resolveEditPath(options.root, pathParam) : undefined;
      let originalContent: string | undefined;

      if (absolutePath && edits.length > 0) {
        try {
          originalContent = await options.readFile(absolutePath);
        } catch {
          // Best-effort snapshot only; recovery should still proceed without it.
        }
      }

      try {
        return await base.execute(toolCallId, params, signal, onUpdate);
      } catch (err) {
        if (!absolutePath) {
          throw err;
        }

        let currentContent: string | undefined;
        try {
          currentContent = await options.readFile(absolutePath);
        } catch {
          // Fall through to the original error if readback fails.
        }

        if (typeof currentContent === "string" && edits.length > 0) {
          if (
            didEditLikelyApply({
              originalContent,
              currentContent,
              edits,
            })
          ) {
            return buildEditSuccessResult(pathParam ?? absolutePath, edits.length);
          }
        }

        if (
          typeof currentContent === "string" &&
          err instanceof Error &&
          shouldAddMismatchHint(err)
        ) {
          throw appendMismatchHint(err, currentContent);
        }

        throw err;
      }
    },
  };
}
