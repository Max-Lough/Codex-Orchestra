---
name: orchestra-review
description: "Run an Orchestra-grade adversarial review of existing changes, a branch, or a commit range. Routes OpenAI-authored work to reviewer-claude when installed and available; Anthropic-authored work and Claude-unavailable fallback go to the fresh native Sol reviewer. Use for requested reviews and changes that arrived outside the normal campaign loop."
---

# Orchestra review

Apply the same independent review gate to arbitrary existing changes. This is
an orchestration skill: the Director scopes and dispatches; it never performs
the review or applies fixes itself.

## Procedure

1. **Fix scope and authorship.** Dispatch one scout for `git status`, diff stat,
   exact commits/merge base, commit subjects, affected paths, and whether the
   tree is idle. Default to the user-named scope; otherwise review all current
   staged and unstaged changes. Determine whether the authoring family was
   OpenAI or Anthropic from campaign evidence, not style guesses.
2. **Pin committed work.** When commits exist, pass exact `base_ref` and
   `head_ref` so the reviewer uses a clean throwaway checkout. Never review a
   committed change in a moving live tree. Do not silently commit arbitrary
   on-demand changes; for an uncommitted review, name exact diff commands and
   require the live tree to remain idle.
3. **Choose the reviewer.** OpenAI-authored work → `reviewer-claude` when the
   Claude pack is installed. Anthropic-authored work → fresh native `reviewer`.
   Without the pack, use native `reviewer` and report once that cross-family
   review is not installed.
4. **Write a self-contained review order** containing:
   - **OUTCOME/INTENT:** what the change claims to accomplish.
   - **SCOPE:** exact refs, diff commands, and paths.
   - **AUTHOR FAMILY:** OpenAI or Anthropic, with evidence.
   - **AUTHOR REPORT:** full executor report verbatim, or an explicit statement
     that no report exists and which description/commits supply intent.
   - **TIER:** full by default; inert only when explicitly justified.
   - **VERIFICATION:** `.codex/orchestra.json` manifest verbatim when present,
     otherwise exact relevant checks.
   - **CONSTRAINTS:** timeouts, prohibited commands, and warmup needs as real
     runner arguments where supported; prose alone configures nothing.
5. **Dispatch and relay.** The reviewer independently reads the diff and reruns
   verification. Preserve every finding, engine attribution, integrity warning,
   attempted settings, and finality line.
6. **Fail loudly.** If the installed Claude lane returns
   `REVIEW_UNAVAILABLE`, immediately show exactly:

   `⚠ CROSS-FAMILY REVIEW UNAVAILABLE — Claude did not review this campaign: <reason>. Falling back to fresh-context OpenAI review; work continues.`

   Then dispatch fresh native `reviewer` with the full order and unavailable
   reason. Never describe this as Claude-reviewed.
7. **Report outcome first.** State `APPROVE`, `REVISE`, or
   `REVIEW_UNAVAILABLE`; then blocking findings verbatim, other findings, actual
   verification, engine/fallback status, and integrity warnings.
8. **On REVISE.** Offer or dispatch a bounded executor fix only when changes are
   in scope, paste findings verbatim, and re-review. Two revise cycles trigger
   renewed recon/re-planning or a user decision, not a third identical attempt.

The reviewer never fixes. A `REVIEW_UNAVAILABLE` result is never approval.
