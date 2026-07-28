#!/usr/bin/env bash
# service/text_generation reference handler for source-2's STRUCTURE role (#201 cookbook).
#
# Input on STDIN (JSON): {"prompt": "<text>", "image": "<base64 or null>"}
# Output on STDOUT (JSON): the ct_common::cookbook::IngredientsFragment shape —
#   {"ingredients":[...],"steps":[...],"cookTime":"<str>","difficulty":"<easy|medium|hard>","allergens":[...]}
#
# The photo bytes travel over the Agent-Fabric channel and arrive here as base64; this handler passes
# them straight through to `claude -p --input-format stream-json` as an `image` content block (#4 —
# a text hint pointing at a local file path was NOT reliably acted on by the model). Per #201's
# error-handling addendum, if NO ingredients can be recognized this returns a safe FALLBACK dish,
# never a hard failure. Requires: jq, base64.
# Point CT_LLM_CMD at your LLM CLI (default: `claude`).
set -uo pipefail

# #204: extract the JSON object from the LLM output, FLATTENING newlines first (`tr -d '\n'`) so the
# match spans a pretty-printed / ```json-fenced multi-line response. `grep` is line-oriented, so
# without the flatten a multi-line object (the LLM emits one ~1 in 3 calls) matched NOTHING on every
# line and the handler silently fell through to its fallback — the "ask for eggs, get plain pasta" bug.
extract_json_object() { tr -d '\n' | grep -o '{.*}' | head -1; }

if [ "${1:-}" = "--selftest" ]; then
  sample='```json
{
  "k": ["eggs", "spinach"],
  "n": 2
}
```'
  got="$(printf '%s' "$sample" | extract_json_object)"
  [ -n "$got" ] || { echo "SELFTEST FAIL (#204): multi-line/fenced JSON yielded an EMPTY match" >&2; exit 1; }
  printf '%s' "$got" | python3 -c 'import sys,json; json.loads(sys.stdin.read())' 2>/dev/null \
    || { echo "SELFTEST FAIL (#204): extracted text is not valid JSON" >&2; exit 1; }
  # #205 (frozen): a text-only DISH request (no photo) must infer its ingredients from the dish name,
  # not take the pantry fallback. The live behaviour is model-dependent (the extraction selftest can't
  # exercise it), so pin the fix textually: the system prompt MUST carry the infer-from-named-dish
  # directive + the narrowed "only fall back when the text is empty AND no photo" condition, so neither
  # can be silently removed in a future edit.
  grep -q "A photo is NOT required to recognize a named dish" "$0" \
    || { echo "SELFTEST FAIL (#205): the infer-from-named-dish directive is missing from the system prompt" >&2; exit 1; }
  grep -q "genuinely empty or unusable AND no photo was given" "$0" \
    || { echo "SELFTEST FAIL (#205): the narrowed fallback condition is missing from the system prompt" >&2; exit 1; }
  echo "SELFTEST OK (#204 extraction + #205 infer-from-dish directive present)"
  exit 0
fi
REQ_ID="$$-$(date -u +%s)-$RANDOM"
log() { printf '[%s] handler=structure req=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REQ_ID" "$*" | tee -a "${CT_HANDLER_LOG_DIR:-/home/becke/workflow-pipelines/.demo-checkouts/handler-logs}/structure.log" >&2; }

LLM_TIMEOUT="${CT_HANDLER_TIMEOUT:-45}"
LLM="${CT_LLM_CMD:-claude}"
IN="$(cat)"
PROMPT="$(printf '%s' "$IN" | jq -r '.prompt // ""' 2>/dev/null)"
IMG_B64="$(printf '%s' "$IN" | jq -r '.image // empty' 2>/dev/null)"
RLANG="$(printf '%s' "$IN" | jq -r '.lang // "en"' 2>/dev/null)"   # #201 i18n: output language
COMPLEXITY="$(printf '%s' "$IN" | jq -r '.complexity // "standard"' 2>/dev/null)"
log "start prompt_len=${#PROMPT} has_image=$([ -n "$IMG_B64" ] && echo yes || echo no) complexity=$COMPLEXITY"
T0=$(date +%s)

# #4 fix: mentioning a local file path in the prompt text and hoping the model notices it and
# calls Read on its own is NOT reliable — it depends on the model choosing to act on a text hint
# (measured well under 100% on real photos, not just the ~1-in-3 already tracked by #204's
# multi-line-JSON bug). Passing the decoded bytes as a proper `image` content block via
# --input-format stream-json is deterministic: the model is GIVEN the photo, not told where to
# maybe go look for it. No temp file / no Read tool access needed anymore for the image itself.
HAS_IMAGE=no
if [ -n "$IMG_B64" ] && printf '%s' "$IMG_B64" | base64 -d >/dev/null 2>&1; then
  HAS_IMAGE=yes
fi

case "$COMPLEXITY" in
  simple) COMPLEXITY_NOTE="The user asked for a QUICK & SIMPLE recipe: keep the ingredients list short (use only what's needed), keep steps to the essential minimum (aim for 3-5 short steps), and favor easy/fast preparation." ;;
  elaborate) COMPLEXITY_NOTE="The user asked for a MORE ELABORATE recipe: it's fine to use more ingredients and more involved techniques, and to break the process into more, more detailed steps." ;;
  *) COMPLEXITY_NOTE="" ;;
esac

SYS="You are the recipe-structure agent. From the user's text and (if given) the ingredient photo, output ONLY a compact JSON object, no prose, with EXACTLY these keys: ingredients (array of strings), steps (array of strings, in order), cookTime (a string like '30 minutes'), difficulty (one of: easy, medium, hard), allergens (array of strings; [] if none). Derive the ingredients from BOTH the photo (if given) and the text. IMPORTANT (#205): if the text names a DISH or any ingredients — even with NO photo (e.g. 'Eier mit Senfsoße'/'eggs in mustard sauce', 'spaghetti carbonara', 'a quick omelette') — INFER the ingredients that dish needs and build the recipe from those. A photo is NOT required to recognize a named dish or ingredients; treat the dish name itself as the ingredient source. ONLY return the safe pantry fallback dish (and say so in the first step) if the text is genuinely empty or unusable AND no photo was given — NEVER fall back merely because no photo was attached, or because the text names a dish rather than listing raw ingredients. Never include inedible or unsafe items. If a photo was given but you cannot actually open/view it for any technical reason, do NOT speculate about permissions/access in your output — just note plainly in the first step that the photo couldn't be used and fall back to the text (or the pantry default if the text is also unusable). $COMPLEXITY_NOTE Respond with the JSON object and nothing else."

FULL_SYS="$SYS Write ALL output text (ingredient names, steps, etc.) in this language: $RLANG. The JSON keys stay in English; only the values are translated."
# No filesystem access needed at all now — the image (if any) travels as a content block, not a
# local path, so Read is disallowed along with the rest.
if [ "$HAS_IMAGE" = yes ]; then
  JQ_FILTER='{type:"user",message:{role:"user",content:[{type:"text",text:$txt},{type:"image",source:{type:"base64",media_type:"image/jpeg",data:$b64}}]}}'
  STREAM_IN="$(jq -nc --arg txt "A photo of the available ingredients is attached — look at it and identify what's actually there. ${PROMPT}" \
    --arg b64 "$IMG_B64" \
    "$JQ_FILTER")"
  OUT="$(printf '%s\n' "$STREAM_IN" | timeout "$LLM_TIMEOUT" "$LLM" -p --input-format stream-json --output-format stream-json --verbose \
    --disallowedTools "Edit,Write,Bash,WebFetch,WebSearch,Agent,Read" \
    --append-system-prompt "$FULL_SYS" 2>/dev/null \
    | jq -rs 'map(select(.type=="result")) | last | .result // empty' 2>/dev/null)"
  LLM_STATUS=$?
else
  OUT="$(timeout "$LLM_TIMEOUT" "$LLM" -p "$PROMPT" --output-format text \
    --disallowedTools "Edit,Write,Bash,WebFetch,WebSearch,Agent,Read" \
    --append-system-prompt "$FULL_SYS" 2>/dev/null)"
  LLM_STATUS=$?
fi
[ $LLM_STATUS -eq 124 ] && log "warn llm_timeout after=${LLM_TIMEOUT}s"

JSON="$(printf '%s' "$OUT" | extract_json_object)"
DUR=$(( $(date +%s) - T0 ))
if printf '%s' "$JSON" | grep -q '"ingredients"'; then
  log "done outcome=ok duration=${DUR}s"
  printf '%s\n' "$JSON"
else
  # FALLBACK (#201 error-handling): the LLM failed or recognized nothing — a safe pantry default,
  # not an error, so the customer still gets a usable recipe.
  log "done outcome=fallback duration=${DUR}s llm_status=${LLM_STATUS}"
  printf '{"ingredients":["pasta","olive oil","garlic","salt"],"steps":["We could not read specific ingredients, so here is a reliable pantry dish.","Boil the pasta until al dente","Warm the olive oil with sliced garlic, toss and season"],"cookTime":"15 minutes","difficulty":"easy","allergens":["gluten"]}\n'
fi
