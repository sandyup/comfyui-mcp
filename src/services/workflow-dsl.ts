import type { WorkflowJSON, WorkflowNode } from "../comfyui/types.js";
import { ValidationError } from "../utils/errors.js";

/**
 * A compact, human/LLM-readable DSL that round-trips losslessly to ComfyUI
 * API-format JSON.
 *
 * Grammar (v0):
 *   <id>: <class_type>[ "title"]      # node header (column 0)
 *     <key> = <JSON value>            # literal input (string/number/bool/array/object)
 *     <key> <- <srcId>.<outputIndex>  # connection input -> [srcId, idx]
 *   # line comment ; blank lines ignored
 *
 * Connections use `<-` so they're unambiguous vs JSON-array literals.
 * v0 preserves node ids, class_type, input order, and _meta.title only
 * (other _meta keys are not represented).
 */

function isConnection(value: unknown, workflow: WorkflowJSON): value is [string, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number" &&
    Number.isInteger(value[1]) &&
    Object.prototype.hasOwnProperty.call(workflow, value[0])
  );
}

function sortIds(ids: string[]): string[] {
  const allNumeric = ids.every((id) => /^\d+$/.test(id));
  return [...ids].sort((a, b) =>
    allNumeric ? Number(a) - Number(b) : a.localeCompare(b),
  );
}

export function workflowToDsl(workflow: WorkflowJSON): string {
  const lines: string[] = [];
  for (const id of sortIds(Object.keys(workflow))) {
    const node = workflow[id];
    const title = node._meta?.title;
    lines.push(`${id}: ${node.class_type}${title ? ` ${JSON.stringify(title)}` : ""}`);
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (isConnection(value, workflow)) {
        lines.push(`  ${key} <- ${value[0]}.${value[1]}`);
      } else {
        lines.push(`  ${key} = ${JSON.stringify(value)}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

const HEADER_RE = /^(\S+):\s*(\S+)(?:\s+(".*"))?\s*$/;
const CONN_RE = /^\s+(\S+)\s*<-\s*(\S+)\.(\d+)\s*$/;
const LITERAL_RE = /^\s+(\S+)\s*=\s*(.+)$/;

export function dslToWorkflow(dsl: string): WorkflowJSON {
  const workflow: WorkflowJSON = {};
  let current: WorkflowNode | undefined;
  const rawLines = dsl.split("\n");

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const isIndented = /^\s/.test(line);

    if (!isIndented) {
      const m = HEADER_RE.exec(line);
      if (!m) throw new ValidationError(`Invalid node header on line ${i + 1}: "${line}"`);
      const [, id, classType, titleJson] = m;
      const node: WorkflowNode = { class_type: classType, inputs: {} };
      if (titleJson) {
        node._meta = { title: JSON.parse(titleJson) as string };
      }
      workflow[id] = node;
      current = node;
      continue;
    }

    if (!current) {
      throw new ValidationError(`Input on line ${i + 1} has no preceding node header: "${line}"`);
    }

    const conn = CONN_RE.exec(line);
    if (conn) {
      const [, key, srcId, idx] = conn;
      current.inputs[key] = [srcId, Number(idx)];
      continue;
    }

    const lit = LITERAL_RE.exec(line);
    if (lit) {
      const [, key, valueStr] = lit;
      try {
        current.inputs[key] = JSON.parse(valueStr);
      } catch {
        throw new ValidationError(
          `Invalid JSON value for "${key}" on line ${i + 1}: ${valueStr}`,
        );
      }
      continue;
    }

    throw new ValidationError(`Could not parse input on line ${i + 1}: "${line}"`);
  }

  return workflow;
}
