#!/usr/bin/env node
// Regenerates the "GitHub Stats" block in README.md (between the
// <!--STATS:START--> / <!--STATS:END--> markers) from live GitHub data.
// Run monthly by .github/workflows/update-stats.yml — see that file for the
// cron schedule and the STATS_PAT secret this script needs (repo + read:user
// scopes, so private repos/commits count toward the totals, matching what
// was there before this was automated).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const USERNAME = "OwenLB";
const TOKEN = process.env.STATS_PAT;
if (!TOKEN) {
  console.error("Missing STATS_PAT env var.");
  process.exit(1);
}

// Any of these identifies a commit as "mine" for the lines-of-code tally —
// covers both personal addresses used across repos and GitHub's noreply alias.
const AUTHOR_PATTERN = /lebec\.owen@(yahoo\.fr|gmail\.com)|@users\.noreply\.github\.com$/i;

async function gql(query) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchOwnedRepos() {
  const repos = [];
  let after = null;
  for (;;) {
    const data = await gql(`
      query {
        viewer {
          login
          followers { totalCount }
          repositories(first: 100, ownerAffiliations: [OWNER], isFork: false${after ? `, after: "${after}"` : ""}) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { nameWithOwner stargazerCount defaultBranchRef { name } }
          }
        }
      }
    `);
    const { repositories, followers } = data.viewer;
    repos.push(...repositories.nodes.filter((r) => r.defaultBranchRef));
    if (!repositories.pageInfo.hasNextPage) {
      return { repos, followers: followers.totalCount, totalCount: repositories.totalCount };
    }
    after = repositories.pageInfo.endCursor;
  }
}

async function fetchCommitCount() {
  const res = await fetch(
    `https://api.github.com/search/commits?q=author:${USERNAME}`,
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github.cloak-preview+json",
      },
    }
  );
  const json = await res.json();
  return json.total_count ?? 0;
}

function tallyLinesOfCode(repos) {
  let added = 0;
  let removed = 0;
  const workDir = mkdtempSync(join(tmpdir(), "stats-"));

  for (const repo of repos) {
    const dir = join(workDir, repo.nameWithOwner.replace("/", "__"));
    const url = `https://x-access-token:${TOKEN}@github.com/${repo.nameWithOwner}.git`;
    try {
      execFileSync("git", ["clone", "--quiet", "--bare", url, dir], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      console.error(`Skipping ${repo.nameWithOwner}: clone failed — ${err.message}`);
      continue;
    }

    let log;
    try {
      log = execFileSync(
        "git",
        ["--git-dir", dir, "log", "--no-merges", "--numstat", "--pretty=format:@@@%ae"],
        { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 }
      );
    } catch (err) {
      console.error(`Skipping ${repo.nameWithOwner}: log failed — ${err.message}`);
      continue;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    let isMine = false;
    for (const line of log.split("\n")) {
      if (line.startsWith("@@@")) {
        isMine = AUTHOR_PATTERN.test(line.slice(3));
        continue;
      }
      if (!isMine) continue;
      const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
      if (!m) continue;
      if (m[1] !== "-") added += Number(m[1]);
      if (m[2] !== "-") removed += Number(m[2]);
    }
  }

  rmSync(workDir, { recursive: true, force: true });
  return { added, removed };
}

function dotField(prefix, value, width) {
  const dots = Math.max(0, width - prefix.length - 1 - String(value).length);
  return prefix + ".".repeat(dots) + " " + value;
}

function fmt(n) {
  return n.toLocaleString("en-US");
}

const { repos, followers, totalCount } = await fetchOwnedRepos();
const stars = repos.reduce((sum, r) => sum + r.stargazerCount, 0);
const commits = await fetchCommitCount();
const { added, removed } = tallyLinesOfCode(repos);
const loc = added - removed;

const line1 =
  dotField(". Repos: ", fmt(totalCount), 61) + " | " + dotField("Stars: ", fmt(stars), 59);
const line2 =
  dotField(". Commits: ", fmt(commits), 61) + " | " + dotField("Followers: ", fmt(followers), 59);
const line3 = dotField(
  ". Lines of Code on GitHub: ",
  `${fmt(loc)} (${fmt(added)}++, ${fmt(removed)}--)`,
  123
);

const statsBlock = [line1, line2, line3].join("\n");

const readmePath = new URL("../README.md", import.meta.url);
const readme = readFileSync(readmePath, "utf8");
const updated = readme.replace(
  /(<!--STATS:START-->\n)[\s\S]*?(\n<!--STATS:END-->)/,
  `$1${statsBlock}$2`
);

if (updated === readme) {
  console.log("Stats block unchanged (pattern not found?) — check markers in README.md.");
} else {
  writeFileSync(readmePath, updated);
  console.log("README.md stats block updated.");
}
