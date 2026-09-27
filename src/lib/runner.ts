import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type RunResponse } from "./protocol";

const TEMP_DIR = join(process.cwd(), ".runner_temp");

export async function runCodeIsolated(
  documentId: string,
  revision: number,
  code: string,
  timeoutMs = 5000
): Promise<RunResponse> {
  const startTime = Date.now();
  if (!existsSync(TEMP_DIR)) {
    mkdirSync(TEMP_DIR, { recursive: true });
  }

  const fileId = randomUUID();
  const filePath = join(TEMP_DIR, `run_${fileId}.ts`);

  // Ensure code executes twoSum demo if top-level call isn't present
  let executableCode = code;
  if (!executableCode.includes("console.log") && executableCode.includes("twoSum")) {
    executableCode += `\n\ntry {\n  const res = twoSum([2, 7, 11, 15], 9);\n  console.log("Output: twoSum([2, 7, 11, 15], 9) =>", JSON.stringify(res));\n} catch (err) {\n  console.error(err);\n}\n`;
  }

  try {
    writeFileSync(filePath, executableCode, "utf8");
  } catch (err) {
    return {
      success: false,
      revision,
      status: "error",
      output: "",
      error: err instanceof Error ? err.message : "Failed to prepare execution environment",
      durationMs: Date.now() - startTime,
    };
  }

  return new Promise<RunResponse>((resolve) => {
    let stdout = "";
    let stderr = "";
    let completed = false;

    const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsxCli, filePath], {
      cwd: TEMP_DIR,
      env: { ...process.env, NODE_OPTIONS: "" },
    });

    const timer = setTimeout(() => {
      if (!completed) {
        completed = true;
        child.kill("SIGKILL");
        cleanupFile(filePath);
        resolve({
          success: false,
          revision,
          status: "timeout",
          output: stdout.trim(),
          error: `Execution timed out after ${timeoutMs}ms limit.`,
          durationMs: Date.now() - startTime,
        });
      }
    }, timeoutMs);

    child.stdout.on("data", (data) => {
      stdout += data.toString("utf8");
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString("utf8");
    });

    child.on("error", (err) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      cleanupFile(filePath);
      resolve({
        success: false,
        revision,
        status: "error",
        output: stdout.trim(),
        error: err.message,
        durationMs: Date.now() - startTime,
      });
    });

    child.on("close", (codeExit) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      cleanupFile(filePath);

      const durationMs = Date.now() - startTime;
      const combinedOutput = (stdout + (stderr ? `\nErrors:\n${stderr}` : "")).trim();

      if (codeExit === 0) {
        resolve({
          success: true,
          revision,
          status: "success",
          output: combinedOutput || "(No console output)",
          durationMs,
        });
      } else {
        resolve({
          success: false,
          revision,
          status: "error",
          output: combinedOutput,
          error: stderr.trim() || `Process exited with code ${codeExit}`,
          durationMs,
        });
      }
    });
  });
}

function cleanupFile(filePath: string) {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {}
}
