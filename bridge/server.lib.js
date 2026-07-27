#!/usr/bin/env node
"use strict";

/**
 * cookbook-crew-bridge (Node.js port, thin-bridge migration — see CADS-Tunnel#219):
 * the HTTP bridge the cookbook-demo browser POSTs {prompt, image?, lang?} to.
 *
 * Runs the recipe crew — safety_check, then structure (source-2, with the photo), then
 * presentation (sink, over structure's output), then review (a post-generation safety pass on
 * the FINISHED recipe) — via one configurable shell command per role, and streams back
 * newline-delimited JSON progress events ending in the exact {stage:"built", safety, auction,
 * recipe} (or {stage:"rejected"|"error"}) shape the browser expects.
 *
 * Unlike flappy-demo's bridge (physics ∥ art run in parallel), this crew is SEQUENTIAL:
 * presentation names/themes the actual recipe, so it depends on structure's output, and review
 * depends on the fully assembled card. Same reasoning as the previous Rust bridge (a separate,
 * self-contained bridge per pipeline by design — no shared abstraction with flappy-demo's).
 *
 * Role commands are unchanged from the previous Rust bridge — each is however you reach that
 * role's service/<slug> (in production: a `ct-agent channel` invocation over the real
 * Agent-Fabric tunnel to source-2/sink, built by compose.cookbook-demo.yml from the
 * COOKBOOK_*_GRANT/HOLDER_KEY/NOISE_KEY env vars). This bridge only replaces the HTTP server +
 * wire-format assembly that used to live in CADS-Tunnel core (crates/agent/src/bin/
 * cookbook_bridge.rs + ct_common::cookbook) — the dial mechanism itself was already fully
 * generic/CLI-driven and needed zero core changes to move here.
 *
 * Env:
 *   COOKBOOK_SAFETY_CMD       - stdin=prompt -> stdout {"ok":bool,"reason":str}
 *   COOKBOOK_STRUCTURE_CMD    - stdin={prompt,image,lang} -> stdout {ingredients,steps,cookTime,difficulty,allergens}
 *   COOKBOOK_STRUCTURE_CMD_2, _3, ... - ordered failover candidates (#207 Slice A), contiguous from _2
 *   COOKBOOK_PRESENTATION_CMD - stdin={prompt,structure,lang} -> stdout {dishName,theme,garnish,moodDescription}
 *   COOKBOOK_REVIEW_CMD       - stdin={prompt,recipe} -> stdout {"ok":bool,"reason":str}
 *   COOKBOOK_BRIDGE_LISTEN    - default 0.0.0.0:8789
 *
 * Fail-closed: safety runs first and {ok:false} short-circuits to a rejection (no fragment
 * calls); a role command failing/malformed output -> a terminal {stage:"error"} event; a failed
 * post-build review -> a terminal {stage:"rejected"} event (same shape as a safety rejection) —
 * either way the browser falls back to its local stand-in.
 */

const { spawn } = require("child_process");

const ROLE_CMD_TIMEOUT_MS = 60_000;

/** Run one role command with `input` on stdin. Non-zero exit / empty stdout / timeout -> reject. */
function runCmd(cmd, input, timeoutMs = ROLE_CMD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", cmd], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      reject(new Error(`role command timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    // Best-effort write, same as the Rust bridge: a role command that answers before draining
    // stdin makes this fail with EPIPE - deliberately ignored, the exit code + stdout decide.
    child.stdin.on("error", () => {});
    child.stdin.write(input, () => {});
    child.stdin.end();

    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`spawn role command failed: ${e.message}`));
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        const err = stderr.trim();
        reject(new Error(`role command exited ${code}${err ? `: ${err}` : ""}`));
        return;
      }
      const out = stdout.trim();
      if (!out) {
        reject(new Error(`role command exited ${code} but produced no output`));
        return;
      }
      resolve(out);
    });
  });
}

/** Up to `maxAttempts` tries on failure. */
async function runCmdWithRetries(cmd, input, maxAttempts) {
  let lastErr = new Error("no attempts made");
  for (let i = 0; i < Math.max(maxAttempts, 1); i++) {
    try {
      return await runCmd(cmd, input);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** 3 total attempts - the default for a role with no configured standby. */
function runCmdAsync(cmd, input) {
  return runCmdWithRetries(cmd, input, 3);
}

/**
 * #207 Slice A - ordered-candidate failover: try candidates in order, first success wins.
 * Non-last candidates get exactly 1 attempt (fail fast, fall through); the LAST candidate gets
 * the full 3 attempts (nowhere further to go, worth paying the retry cost). Returns
 * [output, winningIndex] so the caller can report who actually served the request.
 */
async function runWithFallbacks(candidates, input) {
  const lastIndex = candidates.length - 1;
  let lastErr = new Error("no role command configured");
  for (let i = 0; i < candidates.length; i++) {
    const attempts = i === lastIndex ? 3 : 1;
    try {
      const out = await runCmdWithRetries(candidates[i], input, attempts);
      return [out, i];
    } catch (e) {
      if (candidates.length > 1) {
        process.stderr.write(
          `cookbook-crew-bridge: role candidate ${i + 1}/${candidates.length} failed (${e.message}); trying next (#207)\n`
        );
      }
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Primary + contiguous fallbacks <key>_2, <key>_3, ... from env; stop at the first unset. */
function roleCandidates(primaryKey, primary) {
  const v = [primary];
  let n = 2;
  while (process.env[`${primaryKey}_${n}`]) {
    v.push(process.env[`${primaryKey}_${n}`]);
    n += 1;
  }
  return v;
}

function candidateLabel(primary, standby, winningIndex) {
  return winningIndex === 0 ? primary : standby;
}

/** The visible auction for the demo recipe crew (mirrors ct_common::cookbook's demo_auction). */
function demoAuction(structureWho) {
  return [
    { role: "structure", bids: [{ who: structureWho, model: "claude", units: 20, price: 50, win: true }] },
    { role: "presentation", bids: [{ who: "sink", model: "claude", units: 20, price: 40, win: true }] },
  ];
}

/**
 * Merge the structure (source-2) + presentation (sink) fragments into the recipe card - mirrors
 * ct_common::cookbook::RecipeCard::from_fragments. The dish name/theme/plating come from
 * presentation; the ingredients/steps/timing/allergens from structure. Throws on a missing
 * required field (fail closed, never a partial/garbage card). allergens defaults to [] when the
 * model omits it - not a hard error (mirrors the Rust struct's #[serde(default)]).
 */
function assembleRecipe(structureJson, presentationJson) {
  const structure = JSON.parse(structureJson);
  const presentation = JSON.parse(presentationJson);
  for (const k of ["ingredients", "steps", "cookTime", "difficulty"]) {
    if (structure[k] === undefined) throw new Error(`structure fragment missing "${k}"`);
  }
  for (const k of ["dishName", "theme", "garnish", "moodDescription"]) {
    if (presentation[k] === undefined) throw new Error(`presentation fragment missing "${k}"`);
  }
  return {
    dishName: presentation.dishName,
    ingredients: structure.ingredients,
    steps: structure.steps,
    cookTime: structure.cookTime,
    difficulty: structure.difficulty,
    allergens: structure.allergens !== undefined ? structure.allergens : [],
    theme: presentation.theme,
    garnish: presentation.garnish,
    moodDescription: presentation.moodDescription,
  };
}

/** Write one NDJSON event to the response stream. */
function emit(res, ev) {
  res.write(JSON.stringify(ev) + "\n");
}

/**
 * Drive the recipe crew safety -> structure -> presentation -> assemble -> review, streaming one
 * event per step. Terminal event is exactly one of built/rejected/error.
 */
async function runCookbookStreaming(prompt, image, lang, safetyCmd, structureCmds, presentationCmd, reviewCmd, res) {
  // 1. safety_check — text-only for v1 (image moderation is a fast-follow).
  emit(res, { stage: "safety", status: "start" });
  let safetyOut;
  try {
    safetyOut = await runCmdAsync(safetyCmd, prompt);
  } catch (e) {
    return emit(res, { stage: "error", message: `safety_check unreachable: ${e.message}` });
  }
  let verdict;
  try {
    verdict = JSON.parse(safetyOut);
  } catch (e) {
    return emit(res, { stage: "error", message: `safety_check reply not JSON: ${e.message}` });
  }
  if (verdict.ok !== true) {
    const reason = typeof verdict.reason === "string" ? verdict.reason : "rejected by the safety agent";
    return emit(res, { stage: "rejected", safety: { ok: false, reason } });
  }
  emit(res, { stage: "safety", status: "ok" });

  // 2. structure (source-2) — the photo bytes travel over the channel as base64 in the JSON the
  //    role receives; source-2's handler decodes it to a local temp file for its own claude -p.
  emit(res, { stage: "structure", status: "start" });
  const structureInput = JSON.stringify({ prompt, image: image ?? null, lang });
  let structureOut;
  let structureWinner;
  try {
    [structureOut, structureWinner] = await runWithFallbacks(structureCmds, structureInput);
  } catch (e) {
    return emit(res, { stage: "error", message: `structure role unreachable: ${e.message}` });
  }
  emit(res, { stage: "structure", status: "done" });

  // 3. presentation (sink) — names/themes/plates over the ACTUAL recipe, so it takes structure's
  //    output as context. Sequential (not parallel) because of this dependency.
  emit(res, { stage: "presentation", status: "start" });
  let structureVal;
  try {
    structureVal = JSON.parse(structureOut);
  } catch {
    structureVal = null;
  }
  const presentationInput = JSON.stringify({ prompt, structure: structureVal, lang });
  let presentationOut;
  try {
    presentationOut = await runCmdAsync(presentationCmd, presentationInput);
  } catch (e) {
    return emit(res, { stage: "error", message: `presentation role unreachable: ${e.message}` });
  }
  emit(res, { stage: "presentation", status: "done" });

  // 4. assemble the recipe card (fail-closed on a malformed fragment).
  let card;
  try {
    card = assembleRecipe(structureOut, presentationOut);
  } catch (e) {
    return emit(res, { stage: "error", message: `recipe fragments malformed: ${e.message}` });
  }

  // 5. review — a post-generation LLM review of the FINISHED recipe: inedible/poisonous items,
  //    dietary-constraint contradictions, plausible flavour sense. {ok:false} REFUSES the recipe.
  emit(res, { stage: "review", status: "start" });
  const reviewInput = JSON.stringify({ prompt, recipe: card });
  let reviewOut;
  try {
    reviewOut = await runCmdAsync(reviewCmd, reviewInput);
  } catch (e) {
    return emit(res, { stage: "error", message: `review role unreachable: ${e.message}` });
  }
  let reviewVerdict;
  try {
    reviewVerdict = JSON.parse(reviewOut);
  } catch (e) {
    return emit(res, { stage: "error", message: `review reply not JSON: ${e.message}` });
  }
  if (reviewVerdict.ok !== true) {
    const reason =
      typeof reviewVerdict.reason === "string"
        ? reviewVerdict.reason
        : "the recipe review flagged a safety/consistency problem";
    return emit(res, { stage: "rejected", safety: { ok: false, reason } });
  }
  emit(res, { stage: "review", status: "ok" });

  // 6. built — the reviewed, assembled recipe.
  const structureWho = candidateLabel("source-2", "central (standby)", structureWinner);
  emit(res, {
    stage: "built",
    safety: { ok: true, reason: "" },
    auction: demoAuction(structureWho),
    recipe: card,
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function buildHandler(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("invalid JSON body");
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length < 3) {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("tell me a bit more about what you want to cook");
  }
  const image = typeof body.image === "string" ? body.image : null;
  const lang = typeof body.lang === "string" && body.lang ? body.lang : "en";
  const safetyCmd = process.env.COOKBOOK_SAFETY_CMD;
  const structureCmd = process.env.COOKBOOK_STRUCTURE_CMD;
  const presentationCmd = process.env.COOKBOOK_PRESENTATION_CMD;
  const reviewCmd = process.env.COOKBOOK_REVIEW_CMD;
  if (!safetyCmd || !structureCmd || !presentationCmd || !reviewCmd) {
    res.writeHead(500, { "content-type": "text/plain" });
    return res.end("cookbook role commands not configured");
  }
  // #207 Slice A: the structure role (source-2's) is the one that goes dark if source-2's box
  // dies, so it gets an ordered candidate list (primary + optional _2/_3 standbys).
  const structureCmds = roleCandidates("COOKBOOK_STRUCTURE_CMD", structureCmd);

  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-store",
  });
  try {
    await runCookbookStreaming(prompt, image, lang, safetyCmd, structureCmds, presentationCmd, reviewCmd, res);
  } catch (e) {
    // Defensive: runCookbookStreaming should never throw (every branch returns after emit()), but
    // don't let an unexpected bug hang the response open.
    emit(res, { stage: "error", message: `internal bridge error: ${e.message}` });
  } finally {
    res.end();
  }
}

function requestListener(req, res) {
  if (req.method === "POST" && req.url === "/cookbook/build") {
    buildHandler(req, res).catch((e) => {
      try {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`internal error: ${e.message}`);
      } catch {
        /* response already sent */
      }
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

module.exports = {
  runCmd,
  runCmdWithRetries,
  runCmdAsync,
  runWithFallbacks,
  roleCandidates,
  candidateLabel,
  demoAuction,
  assembleRecipe,
  runCookbookStreaming,
  buildHandler,
  requestListener,
};
