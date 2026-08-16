// Generates a GitHub profile README from public API data.
//
// Reusing this on another account needs no code changes: the username comes
// from GITHUB_REPOSITORY_OWNER in Actions, or PROFILE_USERNAME / the first CLI
// argument when run locally. Everything else is optional configuration read
// from the environment, documented in .github/workflows/update-profile.yml.
//
//   node scripts/generate-profile.mjs <username>
//
// A token is optional but recommended: without one the GraphQL calls are
// skipped, so the contribution graph, snapshot breakdown, and language colors
// are omitted while the rest still renders.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const outputPath = path.join(repositoryRoot, "README.md");
const nowSectionPath = path.join(repositoryRoot, "WHATS_NEW.md");
const assetsDirectory = path.join(repositoryRoot, "assets");

// Hour-of-day stats are reported in this offset so the histogram can match the
// author's own clock. Defaults to UTC, since the API exposes no timezone.
const localUtcOffsetHours = Number(process.env.PROFILE_UTC_OFFSET || 0);

// Dates and numbers are formatted with this locale.
const locale = process.env.PROFILE_LOCALE || "en";

// Accent used for the location badge. Any hex color without the leading "#".
const accentColor = (process.env.PROFILE_ACCENT_COLOR || "57606A").replace(
  /^#/,
  "",
);

// Optional: a URL to a now-playing image (for example a self-hosted novatorem
// deployment). The section is skipped entirely when this is not configured.
const spotifyStatusUrl = process.env.SPOTIFY_STATUS_URL || "";
const spotifyProfileUrl = process.env.SPOTIFY_PROFILE_URL || "";

const username =
  process.env.PROFILE_USERNAME ||
  process.env.GITHUB_REPOSITORY_OWNER ||
  process.env.GITHUB_REPOSITORY?.split("/")[0] ||
  process.argv[2];

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!username) {
  throw new Error(
    "Set PROFILE_USERNAME or GITHUB_REPOSITORY_OWNER, or pass a username as the first argument.",
  );
}

const apiHeaders = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "dynamic-github-profile-readme",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

// Badge color when GitHub reports no color for a language.
const fallbackLanguageColor = "8B949E";

// Optional per-language logo slugs, resolved against shields.io's icon set.
// This is a presentation nicety, not a data source: any language missing here
// simply renders without a logo, so the table never needs to be exhaustive.
const languageLogos = {
  C: { logo: "c", logoColor: "black" },
  "C#": { logo: "csharp" },
  "C++": { logo: "cplusplus" },
  CSS: { logo: "css" },
  Dart: { logo: "dart" },
  Go: { logo: "go" },
  HTML: { logo: "html5" },
  Java: { logo: "openjdk" },
  JavaScript: { logo: "javascript", logoColor: "black" },
  Kotlin: { logo: "kotlin" },
  Lua: { logo: "lua" },
  Makefile: { logo: "gnu" },
  PHP: { logo: "php" },
  Python: { logo: "python" },
  Ruby: { logo: "ruby" },
  Rust: { logo: "rust", logoColor: "black" },
  Shell: { logo: "gnubash" },
  Swift: { logo: "swift" },
  TypeScript: { logo: "typescript" },
};

function githubApi(route) {
  return `https://api.github.com${route}`;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...apiHeaders,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `${response.status} ${response.statusText} for ${url}: ${details.slice(0, 300)}`,
    );
  }

  return response;
}

async function getJson(route) {
  return (await request(githubApi(route))).json();
}

async function getOptionalJson(route, fallback = null) {
  try {
    return await getJson(route);
  } catch (error) {
    console.warn(`Skipping ${route}: ${error.message}`);
    return fallback;
  }
}

async function graphql(query, variables) {
  if (!token) {
    return null;
  }

  try {
    const payload = await request(githubApi("/graphql"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const result = await payload.json();

    if (result.errors) {
      throw new Error(result.errors.map((error) => error.message).join("; "));
    }

    return result.data;
  } catch (error) {
    console.warn(`Skipping GraphQL data: ${error.message}`);
    return null;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// The contributor-stats endpoint computes asynchronously: it answers 202 with
// an empty body while GitHub builds the cache, so a few polite retries are
// needed before the numbers are actually available.
async function getContributorStats(repository, attempts = 6) {
  const url = githubApi(`/repos/${repository.full_name}/stats/contributors`);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;

    try {
      response = await fetch(url, { headers: apiHeaders });
    } catch (error) {
      console.warn(`Skipping stats for ${repository.full_name}: ${error.message}`);
      return null;
    }

    if (!response.ok && response.status !== 202) {
      console.warn(
        `Skipping stats for ${repository.full_name}: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    const body = (await response.text()).trim();

    if (response.status === 202 || body === "") {
      await delay(2000);
      continue;
    }

    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  console.warn(`Stats for ${repository.full_name} were still building.`);
  return null;
}

async function countAuthoredLines(repositories) {
  let added = 0;
  let removed = 0;
  let counted = 0;
  let skipped = 0;

  // Sequential on purpose: this endpoint is expensive for GitHub to build and
  // parallel requests make the 202-retry loop far more likely to be hit.
  for (const repository of repositories) {
    const stats = await getContributorStats(repository);
    if (!Array.isArray(stats)) {
      skipped += 1;
      continue;
    }

    const mine = stats.find(
      (entry) =>
        entry.author?.login?.toLowerCase() === username.toLowerCase(),
    );
    if (!mine) continue;

    for (const week of mine.weeks || []) {
      added += week.a || 0;
      removed += week.d || 0;
    }
    counted += 1;
  }

  return { added, removed, counted, skipped };
}

async function listPublicRepositories() {
  const repositories = [];

  for (let page = 1; page <= 10; page += 1) {
    const batch = await getJson(
      `/users/${encodeURIComponent(username)}/repos?type=owner&sort=updated&per_page=100&page=${page}`,
    );
    repositories.push(...batch);

    if (batch.length < 100) {
      break;
    }
  }

  return repositories;
}

async function getProfileGraphData() {
  const to = new Date();
  const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);

  return graphql(
    `
      query ProfileData($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          bio
          contributionsCollection(from: $from, to: $to) {
            contributionCalendar {
              totalContributions
              weeks {
                contributionDays {
                  contributionCount
                  date
                }
              }
            }
            totalCommitContributions
            totalIssueContributions
            totalPullRequestContributions
            totalPullRequestReviewContributions
            commitContributionsByRepository(maxRepositories: 100) {
              repository {
                nameWithOwner
                url
                isPrivate
                stargazerCount
                owner {
                  login
                }
              }
              contributions {
                totalCount
              }
            }
            pullRequestContributionsByRepository(maxRepositories: 100) {
              repository {
                nameWithOwner
                url
                isPrivate
                stargazerCount
                owner {
                  login
                }
              }
              contributions {
                totalCount
              }
            }
          }
          repositories(
            first: 100
            isFork: false
            privacy: PUBLIC
            ownerAffiliations: OWNER
          ) {
            nodes {
              languages(first: 25) {
                nodes {
                  name
                  color
                }
              }
            }
          }
          pinnedItems(first: 6, types: REPOSITORY) {
            nodes {
              ... on Repository {
                nameWithOwner
                description
                url
                stargazerCount
                forkCount
                primaryLanguage {
                  name
                }
              }
            }
          }
        }
      }
    `,
    {
      login: username,
      from: from.toISOString(),
      to: to.toISOString(),
    },
  );
}

// All-time pull requests the user opened anywhere. The GraphQL contributions
// collection only covers the queried year, so this catches older work.
async function searchAuthoredPullRequests() {
  const query = encodeURIComponent(`type:pr author:${username}`);
  const payload = await getOptionalJson(
    `/search/issues?q=${query}&per_page=100&sort=created&order=desc`,
    null,
  );

  return payload?.items || [];
}

function collectContributedRepositories(graphData, pullRequests) {
  const contributions = new Map();
  const isOwn = (owner) => owner.toLowerCase() === username.toLowerCase();

  const entryFor = (nameWithOwner, url, stars) => {
    if (!contributions.has(nameWithOwner)) {
      contributions.set(nameWithOwner, {
        nameWithOwner,
        url,
        stars: stars ?? 0,
        commits: 0,
        pullRequests: 0,
        merged: 0,
      });
    }
    const entry = contributions.get(nameWithOwner);
    // Star counts only arrive with the GraphQL rows, so keep the best value.
    if (stars != null && stars > entry.stars) entry.stars = stars;
    return entry;
  };

  const collection = graphData?.user?.contributionsCollection;

  for (const row of collection?.commitContributionsByRepository || []) {
    const repository = row.repository;
    if (!repository || repository.isPrivate) continue;
    if (isOwn(repository.owner?.login || "")) continue;

    entryFor(
      repository.nameWithOwner,
      repository.url,
      repository.stargazerCount,
    ).commits += row.contributions?.totalCount || 0;
  }

  for (const row of collection?.pullRequestContributionsByRepository || []) {
    const repository = row.repository;
    if (!repository || repository.isPrivate) continue;
    if (isOwn(repository.owner?.login || "")) continue;

    entryFor(
      repository.nameWithOwner,
      repository.url,
      repository.stargazerCount,
    ).pullRequests += row.contributions?.totalCount || 0;
  }

  // The search results are all-time, so they may name repositories the
  // one-year GraphQL window missed entirely.
  const seenPullRequests = new Map();

  for (const item of pullRequests) {
    const nameWithOwner = item.repository_url?.replace(
      "https://api.github.com/repos/",
      "",
    );
    if (!nameWithOwner || !nameWithOwner.includes("/")) continue;
    if (isOwn(nameWithOwner.split("/")[0])) continue;

    const counts = seenPullRequests.get(nameWithOwner) || {
      total: 0,
      merged: 0,
    };
    counts.total += 1;
    if (item.pull_request?.merged_at) counts.merged += 1;
    seenPullRequests.set(nameWithOwner, counts);
  }

  for (const [nameWithOwner, counts] of seenPullRequests) {
    const entry = entryFor(
      nameWithOwner,
      `https://github.com/${nameWithOwner}`,
      null,
    );
    // Prefer the all-time search count over the windowed GraphQL one rather
    // than adding them, which would double-count the overlap.
    entry.pullRequests = Math.max(entry.pullRequests, counts.total);
    entry.merged = counts.merged;
  }

  return [...contributions.values()].sort(
    (left, right) =>
      right.merged - left.merged ||
      right.pullRequests - left.pullRequests ||
      right.commits - left.commits ||
      right.stars - left.stars,
  );
}

function renderContributedRepositories(contributed) {
  if (contributed.length === 0) return "";

  const rows = contributed.slice(0, 10).map((entry) => {
    const parts = [];
    if (entry.merged > 0) {
      parts.push(`${entry.merged} merged PR${entry.merged === 1 ? "" : "s"}`);
    } else if (entry.pullRequests > 0) {
      parts.push(
        `${entry.pullRequests} pull request${entry.pullRequests === 1 ? "" : "s"}`,
      );
    }
    if (entry.commits > 0) {
      parts.push(`${entry.commits} commit${entry.commits === 1 ? "" : "s"}`);
    }

    const stars = entry.stars > 0 ? `★ ${formatNumber(entry.stars)}` : "";
    return `| [${entry.nameWithOwner}](${entry.url}) | ${parts.join(" · ") || "—"} | ${stars} |`;
  });

  return [
    "| Repository | My contributions | Stars |",
    "| --- | --- | ---: |",
    ...rows,
  ].join("\n");
}

async function attachLanguages(repositories) {
  return Promise.all(
    repositories.map(async (repository) => ({
      ...repository,
      languages:
        (await getOptionalJson(
          `/repos/${repository.full_name}/languages`,
          {},
        )) || {},
    })),
  );
}

function aggregateLanguages(repositories) {
  const totals = new Map();

  for (const repository of repositories) {
    for (const [language, bytes] of Object.entries(repository.languages || {})) {
      totals.set(language, (totals.get(language) || 0) + bytes);
    }
  }

  const totalBytes = [...totals.values()].reduce((sum, bytes) => sum + bytes, 0);

  return [...totals.entries()]
    .map(([name, bytes]) => ({
      name,
      bytes,
      percentage: totalBytes === 0 ? 0 : (bytes / totalBytes) * 100,
    }))
    .sort((left, right) => right.bytes - left.bytes);
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cleanMarkdownText(value) {
  return decodeHtml(value)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAttribute(tag, attribute) {
  return decodeHtml(
    tag.match(new RegExp(`\\b${attribute}="([^"]*)"`, "i"))?.[1] || "",
  );
}

async function getAchievements() {
  try {
    const response = await fetch(
      `https://github.com/${encodeURIComponent(username)}?tab=achievements`,
      { headers: { "User-Agent": apiHeaders["User-Agent"] } },
    );

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const achievements = new Map();

    for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
      const tag = match[0];
      const alt = extractAttribute(tag, "alt");

      if (!alt.startsWith("Achievement: ")) {
        continue;
      }

      const name = alt.slice("Achievement: ".length);
      const image = extractAttribute(tag, "src");
      const hovercard = extractAttribute(tag, "data-hovercard-url");
      const slug =
        hovercard.match(/\/achievements\/([^/]+)\//)?.[1] ||
        name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

      if (name && image && !achievements.has(name)) {
        achievements.set(name, {
          name,
          image: new URL(image, "https://github.com").href,
          url: `https://github.com/${username}?achievement=${encodeURIComponent(slug)}&tab=achievements`,
        });
      }
    }

    return [...achievements.values()];
  } catch (error) {
    console.warn(`Skipping achievements: ${error.message}`);
    return [];
  }
}

function repositoryUrl(fullName) {
  return `https://github.com/${fullName}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function eventDescription(event) {
  const repository = event.repo?.name;
  if (!repository) {
    return null;
  }

  const repositoryLink = `[${repository}](${repositoryUrl(repository)})`;
  const action = event.payload?.action;

  switch (event.type) {
    case "PushEvent": {
      const count = event.payload?.size || event.payload?.commits?.length || 0;
      return count > 0
        ? `Pushed ${count} commit${count === 1 ? "" : "s"} to ${repositoryLink}`
        : `Pushed updates to ${repositoryLink}`;
    }
    case "PullRequestEvent": {
      const number = event.payload?.number || event.payload?.pull_request?.number;
      const url =
        event.payload?.pull_request?.html_url ||
        `${repositoryUrl(repository)}/pull/${number}`;
      return `${capitalize(action)} [pull request #${number}](${url}) in ${repositoryLink}`;
    }
    case "IssuesEvent": {
      const number = event.payload?.issue?.number;
      const url =
        event.payload?.issue?.html_url ||
        `${repositoryUrl(repository)}/issues/${number}`;
      return `${capitalize(action)} [issue #${number}](${url}) in ${repositoryLink}`;
    }
    case "IssueCommentEvent": {
      const number = event.payload?.issue?.number;
      const url =
        event.payload?.issue?.html_url ||
        `${repositoryUrl(repository)}/issues/${number}`;
      return `Commented on [issue #${number}](${url}) in ${repositoryLink}`;
    }
    case "CreateEvent": {
      const reference = event.payload?.ref ? ` \`${event.payload.ref}\`` : "";
      return `Created ${event.payload?.ref_type || "repository"}${reference} in ${repositoryLink}`;
    }
    case "ReleaseEvent":
      return `${capitalize(action)} [${event.payload?.release?.name || event.payload?.release?.tag_name || "a release"}](${event.payload?.release?.html_url}) in ${repositoryLink}`;
    case "ForkEvent":
      return `Forked ${repositoryLink} to [${event.payload?.forkee?.full_name}](${event.payload?.forkee?.html_url})`;
    case "WatchEvent":
      return `Starred ${repositoryLink}`;
    case "PublicEvent":
      return `Made ${repositoryLink} public`;
    default:
      return null;
  }
}

function capitalize(value) {
  if (!value) return "Updated";
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

async function getPublicEvents() {
  const events = [];

  for (let page = 1; page <= 3; page += 1) {
    const batch =
      (await getOptionalJson(
        `/users/${encodeURIComponent(username)}/events/public?per_page=100&page=${page}`,
        [],
      )) || [];
    events.push(...batch);

    if (batch.length < 100) {
      break;
    }
  }

  return events;
}

function buildRecentActivity(events) {
  const activity = [];
  const seen = new Set();

  // Sort before deduplicating so the newest event wins its signature and the
  // rendered list is genuinely in reverse-chronological order.
  const ordered = [...events].sort(
    (left, right) => new Date(right.created_at) - new Date(left.created_at),
  );

  for (const event of ordered) {
    const description = eventDescription(event);
    if (!description) continue;

    const signature = `${event.type}:${event.repo?.name}:${event.payload?.action || ""}`;
    if (seen.has(signature)) continue;

    seen.add(signature);
    activity.push({
      date: formatDate(event.created_at),
      description,
    });

    if (activity.length === 5) break;
  }

  return activity;
}

function shieldBadge(label, message, style, options = {}) {
  const encodedLabel = encodeURIComponent(label);
  const color = options.color || "0969DA";
  const query = new URLSearchParams({ style });

  if (options.logo) query.set("logo", options.logo);
  if (options.logoColor) query.set("logoColor", options.logoColor);

  if (message === "") {
    return `https://img.shields.io/badge/${encodedLabel}-${color}?${query}`;
  }

  const encodedMessage = encodeURIComponent(message);
  return `https://img.shields.io/badge/${encodedLabel}-${encodedMessage}-${color}?${query}`;
}

function image(url, alt) {
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" />`;
}

// Some linguist colors are near-black, which disappears against the dark
// theme. Rather than curate exceptions, lift anything below a luminance floor
// toward white until it reads on both themes.
function ensureReadableColor(hex, minimumLuminance = 0.22) {
  const value = hex.padStart(6, "0").slice(0, 6);
  let channels = [0, 2, 4].map((offset) =>
    parseInt(value.slice(offset, offset + 2), 16),
  );

  if (channels.some(Number.isNaN)) return fallbackLanguageColor;

  const luminance = () =>
    (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255;

  // Blend toward white in small steps so the hue is preserved.
  for (let step = 0; step < 20 && luminance() < minimumLuminance; step += 1) {
    channels = channels.map((channel) => Math.round(channel + (255 - channel) * 0.15));
  }

  return channels
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

// GitHub reports each language's own linguist color, so the palette adapts to
// whatever languages a profile actually uses instead of a fixed list.
function buildLanguageColors(graphData) {
  const colors = new Map();

  for (const repository of graphData?.user?.repositories?.nodes || []) {
    for (const language of repository?.languages?.nodes || []) {
      if (!language?.name || !language.color) continue;
      colors.set(
        language.name,
        ensureReadableColor(language.color.replace(/^#/, "")),
      );
    }
  }

  return colors;
}

function languageBadge(language, colors) {
  const style = {
    ...(languageLogos[language.name] || {}),
    color: colors.get(language.name) || fallbackLanguageColor,
  };
  const percentage =
    language.percentage < 0.1
      ? "<0.1%"
      : `${language.percentage.toFixed(1)}%`;
  return image(
    shieldBadge(language.name, percentage, "flat-square", style),
    `${language.name} ${percentage}`,
  );
}

function renderBadges(badges, indent = "  ") {
  return `<p>\n${badges.map((badge) => `${indent}${badge}`).join("\n")}\n</p>`;
}

function renderAchievements(achievements) {
  if (achievements.length === 0) {
    return `See my [GitHub achievements](https://github.com/${username}?tab=achievements).`;
  }

  const cells = achievements
    .map(
      (achievement) => `      <td align="center" width="180">
        <a href="${escapeHtml(achievement.url)}">
          <img src="${escapeHtml(achievement.image)}" width="80" alt="${escapeHtml(achievement.name)} achievement" />
          <br />
          <strong>${escapeHtml(achievement.name)}</strong>
        </a>
      </td>`,
    )
    .join("\n");

  return `<div align="center">
  <table>
    <tr>
${cells}
    </tr>
  </table>
</div>`;
}

function renderRecentActivity(activity) {
  if (activity.length === 0) {
    return "Recent public activity will appear here automatically.";
  }

  return activity
    .map((entry) => `- **${entry.date}:** ${entry.description}`)
    .join("\n");
}

// GitHub's own contribution-grid palettes, darkest step last.
const contributionPalettes = {
  light: {
    empty: "#ebedf0",
    levels: ["#9be9a8", "#40c463", "#30a14e", "#216e39"],
    text: "#57606a",
  },
  dark: {
    empty: "#161b22",
    levels: ["#0e4429", "#006d32", "#26a641", "#39d353"],
    text: "#8b949e",
  },
};

function contributionLevel(count, max) {
  if (count <= 0) return 0;
  if (max <= 0) return 0;
  // Four filled steps, matching the granularity GitHub itself renders.
  return Math.min(4, Math.ceil((count / max) * 4));
}

function renderContributionSvg(weeks, theme) {
  const palette = contributionPalettes[theme];
  const cell = 11;
  const gap = 3;
  const pitch = cell + gap;
  const topMargin = 20;
  const leftMargin = 4;

  const counts = weeks.flatMap((week) =>
    week.contributionDays.map((day) => day.contributionCount),
  );
  const max = Math.max(1, ...counts);

  const width = leftMargin * 2 + weeks.length * pitch - gap;
  const height = topMargin + 7 * pitch - gap + 4;

  const squares = [];
  const monthLabels = [];
  let lastMonth = null;

  weeks.forEach((week, weekIndex) => {
    week.contributionDays.forEach((day) => {
      const date = new Date(`${day.date}T00:00:00Z`);
      const dayIndex = date.getUTCDay();
      const level = contributionLevel(day.contributionCount, max);
      const fill = level === 0 ? palette.empty : palette.levels[level - 1];
      const x = leftMargin + weekIndex * pitch;
      const y = topMargin + dayIndex * pitch;

      squares.push(
        `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" ry="2" fill="${fill}"><title>${day.contributionCount} on ${day.date}</title></rect>`,
      );
    });

    // Label a month at the first week that lands in it, skipping the first
    // column so a partial leading week does not push a label off the edge.
    const firstDay = week.contributionDays[0];
    if (!firstDay) return;
    const month = new Date(`${firstDay.date}T00:00:00Z`).getUTCMonth();
    if (month !== lastMonth && weekIndex > 0) {
      const name = new Intl.DateTimeFormat(locale, {
        month: "short",
        timeZone: "UTC",
      }).format(new Date(`${firstDay.date}T00:00:00Z`));
      monthLabels.push(
        `<text x="${leftMargin + weekIndex * pitch}" y="12" fill="${palette.text}" font-size="10" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${name}</text>`,
      );
    }
    lastMonth = month;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Contribution graph for the last year">
${monthLabels.join("\n")}
${squares.join("\n")}
</svg>
`;
}

async function writeContributionGraphs(graphData) {
  const weeks =
    graphData?.user?.contributionsCollection?.contributionCalendar?.weeks || [];

  // Without a token the calendar is unavailable; leave any previously
  // generated files in place rather than blanking the section.
  if (weeks.length === 0) return false;

  await mkdir(assetsDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(assetsDirectory, "contribution-graph.svg"),
      renderContributionSvg(weeks, "light"),
      "utf8",
    ),
    writeFile(
      path.join(assetsDirectory, "contribution-graph-dark.svg"),
      renderContributionSvg(weeks, "dark"),
      "utf8",
    ),
  ]);

  return true;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatNumber(value) {
  return new Intl.NumberFormat(locale).format(value);
}

function pickFeaturedRepositories(graphData, repositories) {
  const pinned = (graphData?.user?.pinnedItems?.nodes || []).filter(Boolean);

  if (pinned.length > 0) {
    return pinned.map((repository) => ({
      name: repository.nameWithOwner.split("/").at(-1),
      description: repository.description || "",
      url: repository.url,
      stars: repository.stargazerCount,
      forks: repository.forkCount,
      language: repository.primaryLanguage?.name || "",
    }));
  }

  // Without pinned repositories, fall back to the most-starred projects and
  // break ties with whichever was pushed to most recently.
  return [...repositories]
    .sort(
      (left, right) =>
        right.stargazers_count - left.stargazers_count ||
        new Date(right.pushed_at || right.updated_at) -
          new Date(left.pushed_at || left.updated_at),
    )
    .slice(0, 6)
    .map((repository) => ({
      name: repository.name,
      description: repository.description || "",
      url: repository.html_url,
      stars: repository.stargazers_count,
      forks: repository.forks_count,
      language: repository.language || "",
    }));
}

function renderFeaturedProjects(featured) {
  if (featured.length === 0) {
    return "Featured projects will appear here as public repositories are added.";
  }

  const cell = (project) => {
    const meta = [
      project.language ? escapeHtml(project.language) : "",
      `★ ${project.stars}`,
      `⑂ ${project.forks}`,
    ]
      .filter(Boolean)
      .join(" · ");

    // Repositories without a description simply omit the line rather than
    // padding the cell with an empty row.
    const description = project.description
      ? `\n        ${escapeHtml(project.description)}<br />`
      : "";

    return `      <td width="50%" valign="top">
        <a href="${escapeHtml(project.url)}"><strong>${escapeHtml(project.name)}</strong></a><br />${description}
        <sub>${meta}</sub>
      </td>`;
  };

  const rows = [];
  for (let index = 0; index < featured.length; index += 2) {
    const pair = featured.slice(index, index + 2);
    const cells = pair.map(cell);

    // Keep the table rectangular so the second column does not collapse.
    if (cells.length === 1) {
      cells.push('      <td width="50%"></td>');
    }

    rows.push(`    <tr>\n${cells.join("\n")}\n    </tr>`);
  }

  return `<table>\n${rows.join("\n")}\n</table>`;
}

function renderLanguageBar(languages, width = 28) {
  const shown = languages.slice(0, 10);
  if (shown.length === 0) return "";

  const nameWidth = Math.max(...shown.map((language) => language.name.length));

  const lines = shown.map((language) => {
    const filled = Math.max(
      1,
      Math.round((language.percentage / 100) * width),
    );
    const bar = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
    const percentage =
      language.percentage < 0.1 ? "<0.1" : language.percentage.toFixed(1);
    return `${language.name.padEnd(nameWidth)}  ${bar}  ${percentage.padStart(4)}%`;
  });

  return ["```text", ...lines, "```"].join("\n");
}

function commitHourHistogram(events) {
  const hours = new Array(24).fill(0);
  let total = 0;

  for (const event of events) {
    if (event.type !== "PushEvent") continue;

    const utcHour = new Date(event.created_at).getUTCHours();
    const localHour = (utcHour + localUtcOffsetHours + 24) % 24;
    const commits = event.payload?.size || event.payload?.commits?.length || 1;

    hours[localHour] += commits;
    total += commits;
  }

  return { hours, total };
}

function renderCommitClock({ hours, total }) {
  // Public events only cover a rolling window, so a thin sample would show a
  // misleading shape. Skip the chart rather than draw noise.
  if (total < 5) return "";

  const blocks = "▁▂▃▄▅▆▇█";
  const peak = Math.max(...hours);
  const sparkline = hours
    .map((count) => {
      if (count === 0) return " ";
      const level = Math.ceil((count / peak) * (blocks.length - 1));
      return blocks[level];
    })
    .join("");

  const ticks = Array.from({ length: 24 }, (_, hour) =>
    hour % 6 === 0 ? "|" : " ",
  ).join("");
  // Each label is two characters wide, so the following column is consumed by
  // the label itself and must not also emit a space.
  let labelRow = "";
  for (let hour = 0; hour < 24; hour += 1) {
    if (hour % 6 === 0) {
      labelRow += String(hour).padStart(2, "0");
    } else if (hour % 6 !== 1) {
      labelRow += " ";
    }
  }

  const offsetLabel =
    localUtcOffsetHours === 0
      ? "UTC"
      : `UTC${localUtcOffsetHours > 0 ? "+" : ""}${localUtcOffsetHours}`;

  return [
    `When I push, by hour of day (${offsetLabel}, from recent public events):`,
    "",
    "```text",
    sparkline,
    ticks,
    labelRow,
    "```",
  ].join("\n");
}

function renderFunFacts(repositories, languages, commitClock, lineStats) {
  const facts = [];

  // A partial count (rate limiting, or stats caches still building) would
  // understate the total without any visible sign, so report nothing instead.
  const lineStatsComplete =
    lineStats.counted > 0 && lineStats.skipped === 0;

  if (lineStatsComplete && lineStats.added > 0) {
    facts.push(`| Lines of code written | **${formatNumber(lineStats.added)}** |`);
    facts.push(`| Lines deleted | **${formatNumber(lineStats.removed)}** |`);
    facts.push(
      `| Net lines standing | **${formatNumber(lineStats.added - lineStats.removed)}** |`,
    );
  }

  const totalBytes = languages.reduce(
    (sum, language) => sum + language.bytes,
    0,
  );
  if (totalBytes > 0) {
    facts.push(`| Code across public repositories | **${formatBytes(totalBytes)}** |`);
  }

  const licenses = new Map();
  for (const repository of repositories) {
    const license = repository.license?.spdx_id;
    if (!license || license === "NOASSERTION") continue;
    licenses.set(license, (licenses.get(license) || 0) + 1);
  }
  const topLicense = [...licenses.entries()].sort(
    (left, right) => right[1] - left[1],
  )[0];
  if (topLicense) {
    facts.push(
      `| Most-used license | **${topLicense[0]}** (${topLicense[1]} repositories) |`,
    );
  }

  const oldest = [...repositories].sort(
    (left, right) => new Date(left.created_at) - new Date(right.created_at),
  )[0];
  if (oldest) {
    const years =
      (Date.now() - new Date(oldest.created_at)) / (365.25 * 24 * 60 * 60 * 1000);
    facts.push(
      `| Longest-lived project | **${oldest.name}** (${years.toFixed(1)} years) |`,
    );
  }

  if (commitClock.total >= 5) {
    const peakHour = commitClock.hours.indexOf(Math.max(...commitClock.hours));
    facts.push(
      `| Busiest pushing hour | **${String(peakHour).padStart(2, "0")}:00** |`,
    );
  }

  if (facts.length === 0) return "";

  return ["| Detail | Value |", "| --- | ---: |", ...facts].join("\n");
}

async function readNowSection() {
  try {
    const contents = await readFile(nowSectionPath, "utf8");
    // The heading lives in the generated README, so strip a leading one from
    // the hand-edited source to avoid doubling it up. Authoring notes written
    // as HTML comments are for the source file only and should not be copied.
    const body = contents
      .replace(/^\s*#[^\n]*\n/, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
    return body || "";
  } catch {
    return "";
  }
}

function renderNowPlaying() {
  if (!spotifyStatusUrl) return "";

  const badge = `<img src="${escapeHtml(spotifyStatusUrl)}" alt="Currently playing on Spotify" />`;
  return spotifyProfileUrl
    ? `<a href="${escapeHtml(spotifyProfileUrl)}">${badge}</a>`
    : badge;
}

function renderStats(profile, repositories, graphData) {
  const stars = repositories.reduce(
    (sum, repository) => sum + repository.stargazers_count,
    0,
  );
  const contributionsCollection =
    graphData?.user?.contributionsCollection;
  const contributions =
    contributionsCollection?.contributionCalendar?.totalContributions;

  const rows = [
    ["Public repositories", profile.public_repos],
    ["Original public projects", repositories.length],
    ["Followers", profile.followers],
    ["Stars on original repositories", stars],
    contributions == null ? null : ["Contributions in the last 12 months", contributions],
    contributionsCollection == null
      ? null
      : ["— commits", contributionsCollection.totalCommitContributions],
    contributionsCollection == null
      ? null
      : ["— pull requests", contributionsCollection.totalPullRequestContributions],
    contributionsCollection == null
      ? null
      : ["— code reviews", contributionsCollection.totalPullRequestReviewContributions],
    contributionsCollection == null
      ? null
      : ["— issues", contributionsCollection.totalIssueContributions],
  ].filter(Boolean);

  return [
    "| Metric | Total |",
    "| --- | ---: |",
    ...rows.map(([label, value]) => `| ${label} | **${formatNumber(value)}** |`),
  ].join("\n");
}

function buildReadme({
  profile,
  repositories,
  graphData,
  languages,
  achievements,
  activity,
  featured,
  commitClock,
  nowSection,
  hasContributionGraph,
  lineStats,
  contributed,
}) {
  const displayName = escapeHtml(profile.name || profile.login);
  // Only shown when there is a real bio to show — no invented filler.
  const tagline = cleanMarkdownText(profile.bio || graphData?.user?.bio || "");

  const profileBadges = [
    `<a href="https://github.com/${username}?tab=followers"><img src="https://img.shields.io/github/followers/${username}?style=flat-square&label=Followers&color=0969da" alt="GitHub followers" /></a>`,
    `<a href="https://github.com/${username}?tab=repositories"><img src="https://img.shields.io/github/stars/${username}?affiliations=OWNER&style=flat-square&label=Stars&color=0969da" alt="GitHub stars" /></a>`,
  ];

  // Add location badge
  if (profile.location) {
    profileBadges.push(
      image(
        shieldBadge(profile.location, "", "flat-square", { color: accentColor }),
        `Based in ${profile.location}`,
      ),
    );
  }

  // Add GitHub since badge
  const joinedDate = new Intl.DateTimeFormat(locale, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(profile.created_at));
  profileBadges.push(
    image(
      shieldBadge("GitHub since", joinedDate, "flat-square", {
        color: "57606A",
        logo: "github",
      }),
      `GitHub member since ${joinedDate}`,
    ),
  );

  const languageColors = buildLanguageColors(graphData);
  const languageBadges = languages
    .slice(0, 5)
    .map((language) => languageBadge(language, languageColors));
  const funFacts = renderFunFacts(
    repositories,
    languages,
    commitClock,
    lineStats,
  );
  const commitClockChart = renderCommitClock(commitClock);
  const nowPlaying = renderNowPlaying();
  const generatedOn = formatDate(new Date());

  const optionalSection = (heading, body) =>
    body ? `\n## ${heading}\n\n${body}\n` : "";

  return `<!--
  This file is generated by scripts/generate-profile.mjs.
  Edit the generator, not README.md. The scheduled workflow only commits when data changes.
  Optional: create a WHATS_NEW.md and its contents are inlined as a "Now" section.
-->

<div align="center">

  <h1>${displayName}</h1>

${tagline ? `  <p><em>${escapeHtml(tagline)}</em></p>\n` : ""}
  <p>
    ${profileBadges.join("\n    ")}
  </p>
</div>

## Featured Projects

${renderFeaturedProjects(featured)}
${optionalSection("Repositories I Contribute To", renderContributedRepositories(contributed))}${optionalSection("Now", nowSection)}
${
  hasContributionGraph
    ? `## Contribution Graph

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/contribution-graph-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="assets/contribution-graph.svg" />
    <img src="assets/contribution-graph.svg" alt="Contribution graph for the last year" />
  </picture>
</div>

`
    : ""
}## GitHub Snapshot

${renderStats(profile, repositories, graphData)}
${optionalSection("By the Numbers", funFacts)}${optionalSection("Commit Clock", commitClockChart)}
## Languages

Automatically calculated from GitHub's language data for my current public, non-fork, non-archived repositories.

${renderBadges(languageBadges)}

${renderLanguageBar(languages)}

## GitHub Achievements

${renderAchievements(achievements)}

## Recent Public Activity

${renderRecentActivity(activity)}
${optionalSection("Currently Playing", nowPlaying)}
---

<div align="center">
  <sub>Updated automatically · ${generatedOn}</sub>
</div>
`;
}

async function main() {
  const [
    profile,
    publicRepositories,
    graphData,
    achievements,
    events,
    pullRequests,
    nowSection,
  ] = await Promise.all([
    getJson(`/users/${encodeURIComponent(username)}`),
    listPublicRepositories(),
    getProfileGraphData(),
    getAchievements(),
    getPublicEvents(),
    searchAuthoredPullRequests(),
    readNowSection(),
  ]);

  const activity = buildRecentActivity(events);
  const commitClock = commitHourHistogram(events);

  const originalRepositories = publicRepositories.filter(
    (repository) =>
      !repository.fork &&
      !repository.archived &&
      repository.name.toLowerCase() !== username.toLowerCase(),
  );
  const repositories = await attachLanguages(originalRepositories);
  const languages = aggregateLanguages(repositories);
  const featured = pickFeaturedRepositories(graphData, repositories);
  const contributed = collectContributedRepositories(graphData, pullRequests);
  const hasContributionGraph = await writeContributionGraphs(graphData);
  const lineStats = await countAuthoredLines(repositories);
  const readme = buildReadme({
    profile,
    repositories,
    graphData,
    languages,
    achievements,
    activity,
    featured,
    commitClock,
    nowSection,
    hasContributionGraph,
    lineStats,
    contributed,
  });

  await writeFile(outputPath, readme, "utf8");
  console.log(
    `Line stats counted ${lineStats.counted}/${repositories.length} repositories` +
      `${lineStats.skipped > 0 ? ` (${lineStats.skipped} unavailable, totals hidden)` : ""}.`,
  );
  console.log(`Generated ${path.relative(process.cwd(), outputPath)} for ${username}.`);
}

await main();
