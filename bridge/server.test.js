"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// server.lib.js exports the pure logic with no side effects (no socket bind) - server.js is the
// thin entrypoint that wires it to a real HTTP listener. Tests exercise the lib directly.
const mod = require("./server.lib.js");

test("runWithFallbacks: first candidate up -> wins at index 0, standby untouched", async () => {
  const [out, idx] = await mod.runWithFallbacks(["printf primary", "printf standby"], "");
  assert.equal(out, "primary");
  assert.equal(idx, 0);
});

test("runWithFallbacks: primary down -> standby wins at index 1", async () => {
  const [out, idx] = await mod.runWithFallbacks(["false", "printf standby"], "");
  assert.equal(out, "standby");
  assert.equal(idx, 1);
});

test("runWithFallbacks: all candidates fail -> rejects", async () => {
  await assert.rejects(() => mod.runWithFallbacks(["false", "false"], ""));
});

test("runWithFallbacks: single candidate behaves as before", async () => {
  const [out, idx] = await mod.runWithFallbacks(["printf only"], "");
  assert.equal(out, "only");
  assert.equal(idx, 0);
});

test("candidateLabel: index 0 is always the primary, any later index is the standby", () => {
  assert.equal(mod.candidateLabel("source-2", "central (standby)", 0), "source-2");
  assert.equal(mod.candidateLabel("source-2", "central (standby)", 1), "central (standby)");
  assert.equal(mod.candidateLabel("source-2", "central (standby)", 2), "central (standby)");
});

test("roleCandidates: reads primary + contiguous _2/_3, stops at a gap", () => {
  const saved = { ...process.env };
  process.env.R_2 = "cmd2";
  process.env.R_3 = "cmd3";
  delete process.env.R_4;
  assert.deepEqual(mod.roleCandidates("R", "cmd1"), ["cmd1", "cmd2", "cmd3"]);

  delete process.env.R_2;
  process.env.R_3 = "cmd3";
  assert.deepEqual(mod.roleCandidates("R", "cmd1"), ["cmd1"]);

  delete process.env.R_3;
  assert.deepEqual(mod.roleCandidates("R", "cmd1"), ["cmd1"]);
  process.env = saved;
});

test("assembleRecipe: merges structure + presentation fragments with exact field names", () => {
  const structure = '{"ingredients":["2 eggs","spinach","feta"],"steps":["whisk","fold","bake"],"cookTime":"25 minutes","difficulty":"easy","allergens":["egg","dairy"]}';
  const presentation = '{"dishName":"Green Shakshuka Bake","theme":"rustic","garnish":"chili oil + mint","moodDescription":"a sunny brunch for two"}';
  const card = mod.assembleRecipe(structure, presentation);
  assert.deepEqual(card, {
    dishName: "Green Shakshuka Bake",
    ingredients: ["2 eggs", "spinach", "feta"],
    steps: ["whisk", "fold", "bake"],
    cookTime: "25 minutes",
    difficulty: "easy",
    allergens: ["egg", "dairy"],
    theme: "rustic",
    garnish: "chili oil + mint",
    moodDescription: "a sunny brunch for two",
  });
});

test("assembleRecipe: allergens defaults to [] when the model omits it (not a hard error)", () => {
  const structure = '{"ingredients":["rice"],"steps":["boil"],"cookTime":"10 minutes","difficulty":"easy"}';
  const presentation = '{"dishName":"Plain Rice","theme":"simple","garnish":"none","moodDescription":"quick"}';
  const card = mod.assembleRecipe(structure, presentation);
  assert.deepEqual(card.allergens, []);
});

test("assembleRecipe: a missing required structure field is a hard error (fail closed)", () => {
  const presentation = '{"dishName":"X","theme":"y","garnish":"z","moodDescription":"w"}';
  assert.throws(() => mod.assembleRecipe('{"ingredients":[]}', presentation));
});

test("assembleRecipe: a missing required presentation field is a hard error (fail closed)", () => {
  const structure = '{"ingredients":["rice"],"steps":["boil"],"cookTime":"10 minutes","difficulty":"easy"}';
  assert.throws(() => mod.assembleRecipe(structure, '{"dishName":"X"}'));
});

test("runCookbookStreaming: happy path emits sequential stages ending in a built recipe", async () => {
  const safety = 'printf \'{"ok":true,"reason":""}\'';
  const structure = 'printf \'{"ingredients":["egg","spinach"],"steps":["whisk","bake"],"cookTime":"20 minutes","difficulty":"easy","allergens":["egg"]}\'';
  const presentation = 'printf \'{"dishName":"Spinach Bake","theme":"rustic","garnish":"mint","moodDescription":"cozy"}\'';
  const review = 'printf \'{"ok":true,"reason":""}\'';
  const events = await collect(safety, [structure], presentation, review);
  const stages = events.map((e) => e.stage);
  const sIdx = stages.indexOf("structure");
  const pIdx = stages.indexOf("presentation");
  const rIdx = stages.indexOf("review");
  assert.ok(sIdx >= 0 && pIdx > sIdx && rIdx > pIdx, "safety -> structure -> presentation -> review, in order");
  const last = events[events.length - 1];
  assert.equal(last.stage, "built");
  assert.equal(last.recipe.dishName, "Spinach Bake");
  assert.equal(last.recipe.ingredients[0], "egg");
  assert.ok(Array.isArray(last.auction) && last.auction.length > 0);
});

test("runCookbookStreaming: a safety rejection short-circuits before any fragment calls", async () => {
  const safety = 'printf \'{"ok":false,"reason":"not food"}\'';
  const structure = 'printf \'{"ingredients":[],"steps":[],"cookTime":"0","difficulty":"easy"}\'';
  const presentation = 'printf \'{"dishName":"x","theme":"y","garnish":"z","moodDescription":"w"}\'';
  const review = 'printf \'{"ok":true,"reason":""}\'';
  const events = await collect(safety, [structure], presentation, review);
  const last = events[events.length - 1];
  assert.equal(last.stage, "rejected");
  assert.equal(last.safety.ok, false);
  assert.ok(!events.some((e) => e.stage === "structure"), "no roles after a safety reject");
});

test("runCookbookStreaming: a failed post-build review rejects the finished recipe", async () => {
  const safety = 'printf \'{"ok":true,"reason":""}\'';
  const structure = 'printf \'{"ingredients":["egg"],"steps":["whisk"],"cookTime":"5 minutes","difficulty":"easy"}\'';
  const presentation = 'printf \'{"dishName":"x","theme":"y","garnish":"z","moodDescription":"w"}\'';
  const review = 'printf \'{"ok":false,"reason":"contains an inedible item"}\'';
  const events = await collect(safety, [structure], presentation, review);
  const last = events[events.length - 1];
  assert.equal(last.stage, "rejected");
  assert.equal(last.safety.reason, "contains an inedible item");
  assert.ok(!events.some((e) => e.stage === "built"), "no built after a review rejection");
});

test("runCookbookStreaming: a failing role command terminates with a stage:error event", async () => {
  const safety = 'printf \'{"ok":true,"reason":""}\'';
  const presentation = 'printf \'{"dishName":"x","theme":"y","garnish":"z","moodDescription":"w"}\'';
  const review = 'printf \'{"ok":true,"reason":""}\'';
  const events = await collect(safety, ["false"], presentation, review);
  assert.equal(events[events.length - 1].stage, "error");
});

/** Drive runCookbookStreaming with a fake writable response, collecting parsed NDJSON events. */
async function collect(safety, structureCmds, presentation, review) {
  const chunks = [];
  const fakeRes = {
    write(s) { chunks.push(s); return true; },
  };
  await mod.runCookbookStreaming("test prompt", null, "en", safety, structureCmds, presentation, review, fakeRes);
  return chunks.join("").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
