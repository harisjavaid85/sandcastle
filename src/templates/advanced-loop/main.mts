import { run, claudeCode, Output } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

// Advanced loop — plan → implement (sequential) → compose PR → review
//
// Phase 1 (Plan):      An opus planner reads the PRD's open issues, filters
//                      to currently-workable ones, and emits a structured
//                      <plan> JSON.
// Phase 2 (Implement): One sonnet implementer per unblocked issue, dispatched
//                      sequentially on the shared agent branch.
// Phase 3 (PR):        A sonnet pr-composer opens or updates the PR in
//                      complete or partial mode.
// Phase 4 (Review):    Light review (default, sonnet) refines the PR in place
//                      and labels ready-for-human; or full review (opus) runs
//                      /code-review, classifies findings, applies mechanical fixes,
//                      and files judgment issues.
//                      Mode is picked per-PRD via --review=light|full.
//
// The outer loop repeats Phase 1+2 up to LIMITS.outerIter times; Phase 3+4
// run once at the end (clean exit or via the IncompleteError catch).
//
// Model IDs (claude-opus-4-7 / claude-sonnet-4-6) are pinned per phase
// below. Bump them when newer recommended model versions ship.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Sandcastle forwards env into the sandbox but doesn't mutate host process.env;
// load .env here so we can read it.
process.loadEnvFile(new URL("./.env", import.meta.url));

function requireEnv<const N extends string>(...names: N[]): Record<N, string> {
  const missing = names.filter((n) => !process.env[n]?.trim());
  if (missing.length > 0) {
    console.error(
      `Missing required env var(s) in .sandcastle/.env: ${missing.join(", ")}\n` +
        `Set them and re-run. See .sandcastle/.env.example.`,
    );
    process.exit(2);
  }
  return Object.fromEntries(
    names.map((n) => [n, process.env[n]!.trim()]),
  ) as Record<N, string>;
}

const { PRD_SLUG, IMAGE_NAME } = requireEnv("PRD_SLUG", "IMAGE_NAME");
const AGENT_BRANCH = `agent/${PRD_SLUG}`;
const PRD_LABEL = `prd:${PRD_SLUG}`;

// One ISO-stamped dir per invocation; sandcastle file-mode appends to
// <role>.log with its own run-start delimiter, so repeated picks of the
// same role accumulate in one file in execution order.
const RUN_ID = `${PRD_SLUG}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const LOG_DIR = path.resolve(".sandcastle/logs", RUN_ID);
mkdirSync(LOG_DIR, { recursive: true });
console.error(`Logs: ${LOG_DIR}`);

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const LIMITS = {
  outerIter: 20,
  wallTimeMs: 4 * 60 * 60 * 1000,
  sameIssueRetry: 2,
  emptyPlanRetry: 1,
  plannerMaxIter: 1,
  implementerMaxIter: 1,
  reviewerMaxIter: 1,
  prComposerMaxIter: 1,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// Thrown when the loop can't finish all the work. Message carries the reason
// and flows into pr-composer's INCOMPLETE_REASON prompt arg.
class IncompleteError extends Error {}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// openIssues ⊇ unblockedIssues. unblockedIssues is the dispatch subset;
// openIssues is the full open set under PRD_LABEL, used for complete-vs-partial.
const planSchema = z.object({
  unblockedIssues: z.array(z.object({ number: z.number(), title: z.string() })),
  openIssues: z.array(z.number()),
  wipBranches: z.array(z.string()),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
type Plan = z.infer<typeof planSchema>;

// ---------------------------------------------------------------------------
// Shared sandcastle run config
// ---------------------------------------------------------------------------

// CI=true keeps pnpm non-interactive.
const dockerSandbox = docker({ imageName: IMAGE_NAME, env: { CI: "true" } });

const worktreeConfig = {
  branchStrategy: { type: "branch" as const, branch: AGENT_BRANCH },
  copyToWorktree: ["node_modules"],
  hooks: {
    sandbox: {
      onSandboxReady: [
        // Switch git's GitHub remotes to HTTPS + GH_TOKEN so push/fetch don't
        // require an SSH key inside the sandbox.
        { command: "gh auth setup-git" },
        // Store-dir + pnpm + corepack are baked into the image (Dockerfile).
        { command: "pnpm install --prefer-offline" },
      ],
    },
  },
  timeouts: {
    copyToWorktreeMs: 120_000,
    gitSetupMs: 30_000,
    commitCollectionMs: 60_000,
    mergeToHostMs: 60_000,
  },
};

// ---------------------------------------------------------------------------
// Phase 1 — planner
// ---------------------------------------------------------------------------

async function runPlanner(): Promise<Plan> {
  const result = await run({
    sandbox: dockerSandbox,
    name: "planner",
    agent: claudeCode("claude-opus-4-7"),
    promptFile: "./.sandcastle/planner-prompt.md",
    promptArgs: { PRD_LABEL, PRD_SLUG },
    maxIterations: LIMITS.plannerMaxIter,
    output: Output.object({ tag: "plan", schema: planSchema }),
    logging: { type: "file", path: path.join(LOG_DIR, "planner.log") },
  });
  if (result.output.error) {
    throw new Error(
      `planner: ${result.output.error.code}: ${result.output.error.message}`,
    );
  }
  return result.output;
}

// ---------------------------------------------------------------------------
// Phase 2 — implementer
// ---------------------------------------------------------------------------

async function runImplementer(issueNumber: number): Promise<void> {
  await run({
    sandbox: dockerSandbox,
    ...worktreeConfig,
    name: `implementer-${issueNumber}`,
    agent: claudeCode("claude-sonnet-4-6"),
    promptFile: "./.sandcastle/implementer-prompt.md",
    promptArgs: {
      ISSUE_NUMBER: String(issueNumber),
      BRANCH: AGENT_BRANCH,
      PRD_LABEL,
      PRD_SLUG,
    },
    maxIterations: LIMITS.implementerMaxIter,
    logging: {
      type: "file",
      path: path.join(LOG_DIR, `implementer-${issueNumber}.log`),
    },
  });
}

// ---------------------------------------------------------------------------
// Phase 3 — reviewer (light default, full opt-in)
// ---------------------------------------------------------------------------

type ReviewMode = "light" | "full";

async function runReviewer(mode: ReviewMode): Promise<void> {
  const config =
    mode === "full"
      ? {
          model: "claude-opus-4-7" as const,
          promptFile: "./.sandcastle/full-reviewer-prompt.md",
        }
      : {
          model: "claude-sonnet-4-6" as const,
          promptFile: "./.sandcastle/light-reviewer-prompt.md",
        };
  await run({
    sandbox: dockerSandbox,
    ...worktreeConfig,
    name: "reviewer",
    agent: claudeCode(config.model),
    promptFile: config.promptFile,
    promptArgs: { BRANCH: AGENT_BRANCH, PRD_LABEL, PRD_SLUG },
    maxIterations: LIMITS.reviewerMaxIter,
    logging: { type: "file", path: path.join(LOG_DIR, "reviewer.log") },
  });
}

// ---------------------------------------------------------------------------
// Phase 4 — pr-composer
// ---------------------------------------------------------------------------

async function runPRComposer(args: {
  mode: "complete" | "partial";
  reason?: string;
  plan: Plan;
}): Promise<void> {
  await run({
    sandbox: dockerSandbox,
    ...worktreeConfig,
    name: "pr-composer",
    agent: claudeCode("claude-sonnet-4-6"),
    promptFile: "./.sandcastle/pr-composer-prompt.md",
    promptArgs: {
      MODE: args.mode,
      INCOMPLETE_REASON: args.reason ?? "",
      BRANCH: AGENT_BRANCH,
      PRD_LABEL,
      PRD_SLUG,
      OPEN_ISSUES: JSON.stringify(args.plan.openIssues),
      WIP_BRANCHES: JSON.stringify(args.plan.wipBranches),
    },
    maxIterations: LIMITS.prComposerMaxIter,
    logging: { type: "file", path: path.join(LOG_DIR, "pr-composer.log") },
  });
}

// ---------------------------------------------------------------------------
// Outer loop
// ---------------------------------------------------------------------------

async function runAuto(mode: ReviewMode): Promise<void> {
  const startedAt = Date.now();
  const picksByIssue = new Map<number, number>();
  let consecutiveEmpty = 0;

  try {
    for (let i = 0; i < LIMITS.outerIter; i++) {
      if (Date.now() - startedAt > LIMITS.wallTimeMs) {
        throw new IncompleteError(
          `wall-time limit (${LIMITS.wallTimeMs}ms) exceeded`,
        );
      }

      const plan = await runPlanner();

      if (plan.unblockedIssues.length === 0) {
        if (plan.openIssues.length === 0) {
          await phasePR(plan);
          await phaseReview(mode);
          return;
        }
        consecutiveEmpty++;
        if (consecutiveEmpty >= LIMITS.emptyPlanRetry) {
          throw new IncompleteError(
            `empty plan returned ${consecutiveEmpty}× — ${plan.openIssues.length} issues still open but none workable`,
          );
        }
        console.log(
          `Empty plan (${consecutiveEmpty}/${LIMITS.emptyPlanRetry}) — retrying.`,
        );
        continue;
      }

      consecutiveEmpty = 0;

      for (const issue of plan.unblockedIssues) {
        const count = (picksByIssue.get(issue.number) ?? 0) + 1;
        picksByIssue.set(issue.number, count);
        if (count >= LIMITS.sameIssueRetry) {
          throw new IncompleteError(
            `same issue (#${issue.number}) picked ${count}× — stuck`,
          );
        }
      }

      for (const issue of plan.unblockedIssues) {
        console.log(`→ implementer for issue #${issue.number}: ${issue.title}`);
        await runImplementer(issue.number);
      }
    }

    throw new IncompleteError(
      `outer iteration limit (${LIMITS.outerIter}) reached`,
    );
  } catch (e) {
    if (!(e instanceof IncompleteError)) throw e;
    console.error(`Incomplete: ${e.message}`);
    try {
      await phasePR(undefined, e.message);
      await phaseReview(mode);
    } catch (finalizeErr) {
      console.error("Failed to finalize after Incomplete:", finalizeErr);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Phase entry points
// ---------------------------------------------------------------------------

async function phasePlan(): Promise<void> {
  const plan = await runPlanner();
  console.log(JSON.stringify(plan, null, 2));
}

async function phaseImplement(issueNumber: number): Promise<void> {
  await runImplementer(issueNumber);
}

async function phasePR(plan?: Plan, reason?: string): Promise<void> {
  const p = plan ?? (await runPlanner());
  const mode = p.openIssues.length === 0 ? "complete" : "partial";
  const finalReason =
    mode === "partial"
      ? (reason ?? "stalled — no workable issues remain")
      : undefined;
  await runPRComposer({ mode, reason: finalReason, plan: p });
}

async function phaseReview(mode: ReviewMode): Promise<void> {
  await runReviewer(mode);
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

// Parse --review=light|full out of argv. Defaults to light. Only meaningful
// on auto and review subcommands; ignored elsewhere.
function parseReviewMode(argv: string[]): {
  mode: ReviewMode;
  rest: string[];
} {
  let mode: ReviewMode = "light";
  const rest: string[] = [];
  for (const a of argv) {
    if (a === "--review=full" || a === "--review=light") {
      mode = a === "--review=full" ? "full" : "light";
      continue;
    }
    if (a.startsWith("--review=") || a === "--review") {
      console.error(`Invalid flag: ${a}. Use --review=light or --review=full.`);
      process.exit(2);
    }
    rest.push(a);
  }
  return { mode, rest };
}

async function main(): Promise<void> {
  const { mode, rest } = parseReviewMode(process.argv.slice(2));
  const [phase, ...args] = rest;
  switch (phase) {
    case undefined:
    case "auto":
      await runAuto(mode);
      return;
    case "plan":
      await phasePlan();
      return;
    case "implement": {
      const n = Number(args[0]);
      if (!Number.isFinite(n)) {
        console.error("Usage: implement <issue-number>");
        process.exit(2);
      }
      await phaseImplement(n);
      return;
    }
    case "pr":
      await phasePR();
      return;
    case "review":
      await phaseReview(mode);
      return;
    default:
      console.error(
        `Unknown phase: ${phase}. Expected one of: auto, plan, implement <N>, pr, review`,
      );
      process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

try {
  await main();
} catch (e) {
  if (e instanceof IncompleteError) process.exit(1);
  console.error(e);
  process.exit(2);
}
