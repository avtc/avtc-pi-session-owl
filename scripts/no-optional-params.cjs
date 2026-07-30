#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * no-optional-params — flags optional function parameters (`?`) and parameters
 * with default values (`=`) in TypeScript source.
 *
 * Optional params and default-value params make it easy to accidentally omit
 * critical arguments at call sites. Prefer required params with explicit
 * `| null` union types, and pass explicit default values from call sites
 * using named constants (e.g. `NO_FOO`).
 *
 * Usage:
 *   node scripts/no-optional-params.cjs [files-or-dirs...]
 *
 * Exits with code 1 if any optional/default-value params are found in
 * function/method signatures.
 * Skips interface/type/class bodies, import statements, comments, type
 * assertions, and inline type literals.
 */

const fs = require("node:fs");
const path = require("node:path");

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

// Remove string contents and inline comments to avoid false matches
function stripStringsAndComments(line) {
  let result = "";
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inRegex = false;
  let regexDepth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (inRegex) {
      if (ch === "\\") {
        result += "  ";
        i++;
        continue;
      }
      if (ch === "[") {
        regexDepth++;
        result += " ";
        continue;
      }
      if (ch === "]" && regexDepth > 0) {
        regexDepth--;
        result += " ";
        continue;
      }
      if (ch === "/" && regexDepth === 0) {
        inRegex = false;
        // Skip flags
        while (i + 1 < line.length && /[gimsuyv]/.test(line[i + 1])) {
          i++;
          result += " ";
        }
        result += " ";
        continue;
      }
      result += " ";
      continue;
    }
    if (ch === "\\" && (inSingle || inDouble || inTemplate)) {
      result += "  ";
      i++;
      continue;
    }
    if (ch === "'" && !inDouble && !inTemplate) {
      inSingle = !inSingle;
      result += " ";
      continue;
    }
    if (ch === '"' && !inSingle && !inTemplate) {
      inDouble = !inDouble;
      result += " ";
      continue;
    }
    if (ch === "`" && !inSingle && !inDouble) {
      inTemplate = !inTemplate;
      result += " ";
      continue;
    }
    // Regex literal: / preceded by operator, opening paren, or whitespace
    if (
      ch === "/" &&
      !inSingle &&
      !inDouble &&
      !inTemplate &&
      next !== "/" &&
      next !== "*" &&
      (i === 0 || /[=(,[{:;!&|?%~\s]/.test(line[i - 1]))
    ) {
      inRegex = true;
      result += " ";
      continue;
    }
    if (ch === "/" && next === "/" && !inSingle && !inDouble && !inTemplate) {
      result += " ".repeat(line.length - i);
      break;
    }
    result += ch;
  }
  return result;
}

function checkFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const findings = [];

  let inBlockComment = false;
  let inInterfaceOrType = false;
  let interfaceBraceDepth = 0;
  let inClassBody = false;
  let classBraceDepth = 0;

  // Multi-line function signature tracking
  let inFunctionParams = false;
  let funcParamParenDepth = 0;

  let funcParamLines = []; // accumulated stripped lines for current function

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Handle block comments
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!line.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    // Track interface/type declaration bodies
    if (/^\s*(export\s+)?(interface|type)\s/.test(line) && !inInterfaceOrType) {
      inInterfaceOrType = true;
      interfaceBraceDepth = 0;
    }
    if (inInterfaceOrType) {
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      interfaceBraceDepth += opens - closes;
      if (interfaceBraceDepth <= 0) {
        inInterfaceOrType = false;
        interfaceBraceDepth = 0;
      }
      continue;
    }

    // Track class bodies
    if (/^\s*(export\s+)?class\s/.test(line) && !inClassBody) {
      inClassBody = true;
      classBraceDepth = 0;
    }
    if (inClassBody && !inFunctionParams) {
      // Check if this line starts a method (function signature)
      const hasMethodSig =
        /^(?:export\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+)?(?:set\s+)?(?:\w+)\s*\(/.test(trimmed) ||
        /^(?:constructor)\s*\(/.test(trimmed) ||
        /^(?:export\s+)?(?:static\s+)?(?:\w+)\s*=\s*\(/.test(trimmed);
      if (hasMethodSig) {
        // Process this as a function signature below. For multi-line method signatures
        // (params on separate lines), isLineStartFunctionSignature won't re-detect them
        // (no `function` keyword / `=` / same-line `)`), so start accumulation directly here.
        const sigStripped = stripStringsAndComments(line);
        const openIdx = sigStripped.indexOf("(");
        if (openIdx >= 0) {
          let d = 0;
          let closed = false;
          for (let c = openIdx; c < sigStripped.length; c++) {
            if (sigStripped[c] === "(") d++;
            else if (sigStripped[c] === ")") {
              d--;
              if (d === 0) {
                closed = true;
                break;
              }
            }
          }
          if (!closed) {
            // Multi-line method signature — begin accumulating param lines.
            inFunctionParams = true;
            funcParamParenDepth = 0;
            funcParamLines = [{ lineNum: i, stripped: sigStripped }];
            for (let c = 0; c < sigStripped.length; c++) {
              if (sigStripped[c] === "(") funcParamParenDepth++;
              else if (sigStripped[c] === ")") funcParamParenDepth--;
            }
            continue;
          }
          // Single-line method signature — fall through to generic processing below.
        }
      } else {
        const opens = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;
        classBraceDepth += opens - closes;
        if (classBraceDepth <= 0) {
          inClassBody = false;
          classBraceDepth = 0;
        }
        continue;
      }
    }

    if (/^\s*(export\s+)?import\s/.test(line)) continue;

    const stripped = stripStringsAndComments(line);

    // If we're currently accumulating function params, add this line
    if (inFunctionParams) {
      funcParamLines.push({ lineNum: i, stripped });
      for (let c = 0; c < stripped.length; c++) {
        if (stripped[c] === "(") funcParamParenDepth++;
        else if (stripped[c] === ")") funcParamParenDepth--;
      }
      if (funcParamParenDepth <= 0) {
        // Function signature param list is complete
        processFunctionParams(filePath, funcParamLines, findings);
        inFunctionParams = false;
        funcParamParenDepth = 0;

        funcParamLines = [];
      }
      continue;
    }

    // Check if this line starts a function signature
    if (isLineStartFunctionSignature(stripped)) {
      // Find the opening paren
      const openParen = stripped.indexOf("(");
      if (openParen >= 0) {
        // Check if the closing paren is on the same line
        let depth = 0;
        let closeParen = -1;
        for (let c = 0; c < stripped.length; c++) {
          if (stripped[c] === "(") depth++;
          else if (stripped[c] === ")") {
            depth--;
            if (depth === 0) {
              closeParen = c;
              break;
            }
          }
        }
        if (closeParen >= 0) {
          // Single-line function — process immediately
          processFunctionParams(filePath, [{ lineNum: i, stripped }], findings);
        } else {
          // Multi-line function — start accumulating
          inFunctionParams = true;
          funcParamParenDepth = 0;
          // Count parens on this line
          for (let c = 0; c < stripped.length; c++) {
            if (stripped[c] === "(") funcParamParenDepth++;
            else if (stripped[c] === ")") funcParamParenDepth--;
          }

          funcParamLines = [{ lineNum: i, stripped }];
        }
      }
    }
  }

  // Handle case where file ends while in function params (malformed but handle gracefully)
  if (inFunctionParams && funcParamLines.length > 0) {
    processFunctionParams(filePath, funcParamLines, findings);
  }

  return findings;
}

function isLineStartFunctionSignature(line) {
  const trimmed = line.trimStart();
  // Skip control flow keywords that use parens
  if (
    /^(?:if|else|for|while|do|switch|case|catch|return|throw|new|delete|typeof|void|import|require|console|process|super|await|yield|this|self|window|document|Math|JSON|Array|Object|String|Number|Boolean|Date|RegExp|Error|Promise|Set|Map|WeakMap|WeakSet|Symbol|Intl|Reflect|Proxy|Atomics|SharedArrayBuffer|WebAssembly|globalThis)\s*[<(]/.test(
      trimmed,
    )
  )
    return false;
  // function keyword
  if (/^(?:export\s+)?(?:async\s+)?function\s+\w+/.test(trimmed)) return true;
  // method with type annotation after closing paren
  if (/\w+\s*\([^)]*\)\s*:/.test(trimmed)) return true;
  // method with body on same line
  if (/\w+\s*\([^)]*\)\s*\{/.test(trimmed)) return true;
  // arrow property method: name = (args) => or name = async (args) => (single or multi-line)
  if (/\w+\s*=\s*(?:async\s+)?\(/.test(trimmed)) return true;
  // constructor/getter/setter
  if (/^(?:constructor|get|set)\s/.test(trimmed)) return true;
  return false;
}

// Process collected function param lines to find optional/default params
function processFunctionParams(filePath, paramLines, findings) {
  // Join all stripped lines to get the full function signature
  const fullSig = paramLines.map((p) => p.stripped).join(" ");

  // Find the FIRST opening paren (the function's param list)
  const openParen = fullSig.indexOf("(");
  if (openParen < 0) return;

  // Find matching close paren
  let depth = 0;
  let closeParen = -1;
  for (let c = openParen; c < fullSig.length; c++) {
    if (fullSig[c] === "(") depth++;
    else if (fullSig[c] === ")") {
      depth--;
      if (depth === 0) {
        closeParen = c;
        break;
      }
    }
  }
  if (closeParen < 0) return;

  // Extract param list content
  const paramList = fullSig.substring(openParen + 1, closeParen);

  // Split by commas at top level
  const params = splitParamList(paramList);

  for (const param of params) {
    const p = param.trim();
    if (!p || p.startsWith("...")) continue;

    // Check for optional marker: `name?`
    const optMatch = p.match(/^(\w+)\?\s*[:)]/);
    if (optMatch) {
      // Find which line this param is on
      const lineNum = findLineForParam(paramLines, optMatch[1]);
      findings.push({
        file: filePath,
        line: lineNum + 1,
        col: 1,
        param: optMatch[1],
        text: linesAt(filePath, lineNum),
      });
      continue;
    }

    // Check for default value
    const defMatch = matchParamWithDefault(p);
    if (defMatch) {
      const lineNum = findLineForParam(paramLines, defMatch.name);
      findings.push({
        file: filePath,
        line: lineNum + 1,
        col: 1,
        param: defMatch.name,
        text: linesAt(filePath, lineNum),
      });
    }
  }
}

function linesAt(filePath, lineNum) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const allLines = content.split("\n");
    return allLines[lineNum] ? allLines[lineNum].trim() : "";
  } catch {
    return "";
  }
}

function findLineForParam(paramLines, paramName) {
  for (const p of paramLines) {
    if (p.stripped.includes(paramName)) return p.lineNum;
  }
  return paramLines[0] ? paramLines[0].lineNum : 0;
}

// Split a parameter list by commas, respecting nested parens/brackets/braces
function splitParamList(paramList) {
  const params = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < paramList.length; i++) {
    const ch = paramList[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      params.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) params.push(current);
  return params;
}

// Match a parameter that has a default value
// Returns { name: string } or null
function matchParamWithDefault(param) {
  const p = param.replace(/^\.\.\.\s*/, "");

  // Find = at top level (not inside nested types)
  let depth = 0;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "=" && depth === 0 && p[i + 1] !== "=" && p[i + 1] !== ">" && (i === 0 || p[i - 1] !== "=")) {
      // Found the = at top level — extract param name
      let nameEnd = i - 1;
      while (nameEnd >= 0 && /\s/.test(p[nameEnd])) nameEnd--;

      // Look for colon (type annotation separator)
      let colonPos = -1;
      let nestDepth = 0;
      for (let c = nameEnd; c >= 0; c--) {
        if (p[c] === ")" || p[c] === "]" || p[c] === "}") nestDepth++;
        else if (p[c] === "(" || p[c] === "[" || p[c] === "{") {
          if (nestDepth > 0) nestDepth--;
          else break;
        } else if (p[c] === "," || p[c] === "?") break;
        else if (p[c] === ":" && nestDepth === 0) {
          colonPos = c;
          break;
        }
      }

      const searchEnd = colonPos >= 0 ? colonPos - 1 : nameEnd;
      let end = searchEnd;
      while (end >= 0 && /\s/.test(p[end])) end--;

      // Remove optional marker
      if (end >= 0 && p[end] === "?") end--;
      while (end >= 0 && /\s/.test(p[end])) end--;

      let start = end;
      while (start >= 0 && /\w/.test(p[start])) start--;
      start++;

      const name = p.substring(start, end + 1);
      if (name && /^[A-Za-z_]\w*$/.test(name)) {
        return { name };
      }
      break;
    }
  }
  return null;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("Usage: node scripts/no-optional-params.cjs [files-or-dirs...]");
  process.exit(2);
}

let totalFindings = 0;
for (const target of targets) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    continue;
  }
  const files = stat.isDirectory() ? [...walk(target)] : [target];
  for (const file of files) {
    const findings = checkFile(file);
    for (const f of findings) {
      console.log(`${f.file}:${f.line} — optional parameter "${f.param}" (uses ? or default value)`);
      totalFindings++;
    }
  }
}

if (totalFindings > 0) {
  console.log(
    `\nFound ${totalFindings} optional parameter(s). Use required params with \`| null\` and pass explicit defaults from call sites.`,
  );
  process.exit(1);
} else {
  console.log("✓ No optional parameters found.");
}
