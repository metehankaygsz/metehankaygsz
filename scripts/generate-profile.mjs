import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const outputPath = path.join(repositoryRoot, "README.md");

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

const languageStyles = {
  Assembly: { color: "6E4C13" },
  C: { color: "A8B9CC", logo: "c", logoColor: "black" },
  "C#": { color: "512BD4", logo: "csharp" },
  "C++": { color: "00599C", logo: "cplusplus" },
  CSS: { color: "663399", logo: "css" },
  Dart: { color: "0175C2", logo: "dart" },
  Go: { color: "00ADD8", logo: "go" },
  HTML: { color: "E34F26", logo: "html5" },
  Java: { color: "ED8B00", logo: "openjdk" },
  JavaScript: { color: "F7DF1E", logo: "javascript", logoColor: "black" },
  Kotlin: { color: "7F52FF", logo: "kotlin" },
  Lua: { color: "2C2D72", logo: "lua" },
  Makefile: { color: "427819", logo: "gnu" },
  PHP: { color: "777BB4", logo: "php" },
  Python: { color: "3776AB", logo: "python" },
  Ruby: { color: "CC342D", logo: "ruby" },
  Rust: { color: "000000", logo: "rust" },
  Shell: { color: "4EAA25", logo: "gnubash" },
  Swift: { color: "F05138", logo: "swift" },
  TypeScript: { color: "3178C6", logo: "typescript" },
};

const technologyStyles = {
  ".NET": { color: "512BD4", logo: "dotnet" },
  Docker: { color: "2496ED", logo: "docker" },
  FastAPI: { color: "009688", logo: "fastapi" },
  "GitHub Actions": { color: "2088FF", logo: "githubactions" },
  "GNU Make": { color: "427819", logo: "gnu" },
  "Node.js": { color: "5FA04E", logo: "nodedotjs" },
  OpenAI: { color: "412991", logo: "openai" },
  Pytest: { color: "0A9EDC", logo: "pytest" },
  React: { color: "20232A", logo: "react", logoColor: "61DAFB" },
  SDL2: { color: "173B6C" },
  SQLAlchemy: { color: "D71F00", logo: "sqlalchemy" },
  Tailwind: { color: "06B6D4", logo: "tailwindcss" },
  Vite: { color: "646CFF", logo: "vite" },
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
          contributionsCollection(from: $from, to: $to) {
            contributionCalendar {
              totalContributions
            }
            totalCommitContributions
            totalIssueContributions
            totalPullRequestContributions
            totalPullRequestReviewContributions
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

function encodeRepositoryPath(repositoryPath) {
  return repositoryPath.split("/").map(encodeURIComponent).join("/");
}

async function getRepositoryTree(repository) {
  const branch = encodeURIComponent(repository.default_branch);
  return (
    (await getOptionalJson(
      `/repos/${repository.full_name}/git/trees/${branch}?recursive=1`,
      { tree: [] },
    ))?.tree || []
  );
}

async function readRepositoryFile(repository, filePath) {
  try {
    const response = await request(
      githubApi(
        `/repos/${repository.full_name}/contents/${encodeRepositoryPath(filePath)}?ref=${encodeURIComponent(repository.default_branch)}`,
      ),
      { headers: { Accept: "application/vnd.github.raw+json" } },
    );
    return await response.text();
  } catch {
    return "";
  }
}

function packageNamesFromJson(contents) {
  try {
    const manifest = JSON.parse(contents);
    return new Set([
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.devDependencies || {}),
      ...Object.keys(manifest.peerDependencies || {}),
    ]);
  } catch {
    return new Set();
  }
}

async function detectTechnologies(repositories) {
  const technologies = new Set();
  const candidates = [...repositories]
    .sort(
      (left, right) =>
        new Date(right.pushed_at || right.updated_at) -
        new Date(left.pushed_at || left.updated_at),
    )
    .slice(0, 8);

  for (const repository of candidates) {
    const tree = await getRepositoryTree(repository);
    const paths = tree
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path);
    const lowerPaths = paths.map((entry) => entry.toLowerCase());

    if (lowerPaths.some((entry) => entry.endsWith("/dockerfile") || entry === "dockerfile")) {
      technologies.add("Docker");
    }
    if (lowerPaths.some((entry) => entry.startsWith(".github/workflows/"))) {
      technologies.add("GitHub Actions");
    }
    if (lowerPaths.some((entry) => entry.endsWith(".csproj") || entry.endsWith(".sln"))) {
      technologies.add(".NET");
    }
    if (lowerPaths.some((entry) => /(^|\/)makefile$/.test(entry))) {
      technologies.add("GNU Make");
    }
    if (
      lowerPaths.some(
        (entry) =>
          entry.endsWith("vite.config.js") ||
          entry.endsWith("vite.config.ts") ||
          entry.endsWith("vite.config.mjs"),
      )
    ) {
      technologies.add("Vite");
    }
    if (
      lowerPaths.some(
        (entry) =>
          entry.endsWith("tailwind.config.js") ||
          entry.endsWith("tailwind.config.ts") ||
          entry.endsWith("tailwind.config.cjs"),
      )
    ) {
      technologies.add("Tailwind");
    }

    const manifestPaths = paths
      .filter((entry) => {
        const lower = entry.toLowerCase();
        return (
          lower.endsWith("package.json") ||
          /(^|\/)requirements[^/]*\.txt$/.test(lower) ||
          lower.endsWith("pyproject.toml") ||
          /(^|\/)makefile$/.test(lower)
        );
      })
      .slice(0, 12);

    for (const manifestPath of manifestPaths) {
      const contents = await readRepositoryFile(repository, manifestPath);
      const lowerContents = contents.toLowerCase();

      if (manifestPath.toLowerCase().endsWith("package.json")) {
        technologies.add("Node.js");
        const packages = packageNamesFromJson(contents);

        if (packages.has("react")) technologies.add("React");
        if (packages.has("vite")) technologies.add("Vite");
        if (packages.has("tailwindcss")) technologies.add("Tailwind");
      }

      if (/\bfastapi\b/.test(lowerContents)) technologies.add("FastAPI");
      if (/\bopenai\b/.test(lowerContents)) technologies.add("OpenAI");
      if (/\bsqlalchemy\b/.test(lowerContents)) technologies.add("SQLAlchemy");
      if (/\bpytest\b/.test(lowerContents)) technologies.add("Pytest");
      if (/\bsdl2\b/.test(lowerContents)) technologies.add("SDL2");
    }
  }

  return [...technologies].sort((left, right) => left.localeCompare(right));
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
  return new Intl.DateTimeFormat("en", {
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

async function getRecentActivity() {
  const events =
    (await getOptionalJson(
      `/users/${encodeURIComponent(username)}/events/public?per_page=50`,
      [],
    )) || [];
  const activity = [];
  const seen = new Set();

  for (const event of events) {
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

function languageBadge(language) {
  const style = languageStyles[language.name] || { color: "555555" };
  const percentage =
    language.percentage < 0.1
      ? "<0.1%"
      : `${language.percentage.toFixed(1)}%`;
  return image(
    shieldBadge(language.name, percentage, "flat-square", style),
    `${language.name} ${percentage}`,
  );
}

function technologyBadge(name) {
  const style = technologyStyles[name] || { color: "555555" };
  return image(shieldBadge(name, "", "for-the-badge", style), name);
}

function renderBadges(badges, indent = "  ") {
  return `<p>\n${badges.map((badge) => `${indent}${badge}`).join("\n")}\n</p>`;
}

function formatJoinedList(values) {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
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

function renderStats(profile, repositories, graphData) {
  const stars = repositories.reduce(
    (sum, repository) => sum + repository.stargazers_count,
    0,
  );
  const contributions =
    graphData?.user?.contributionsCollection?.contributionCalendar
      ?.totalContributions;

  const rows = [
    ["Public repositories", profile.public_repos],
    ["Original public projects", repositories.length],
    ["Followers", profile.followers],
    ["Stars on original repositories", stars],
    contributions == null ? null : ["Contributions in the last 12 months", contributions],
  ].filter(Boolean);

  return [
    "| Metric | Total |",
    "| --- | ---: |",
    ...rows.map(([label, value]) => `| ${label} | **${value}** |`),
  ].join("\n");
}

function buildReadme({
  profile,
  repositories,
  graphData,
  languages,
  technologies,
  achievements,
  activity,
}) {
  const topLanguageNames = languages.slice(0, 3).map((language) => language.name);
  const taglineText = profile.bio
    ? cleanMarkdownText(profile.bio)
    : topLanguageNames.length
      ? `Building public projects across ${formatJoinedList(topLanguageNames)}.`
      : "Building practical software and learning in public.";
  const tagline = escapeHtml(taglineText);
  const displayName = escapeHtml(profile.name || profile.login);
  const joinedDate = new Intl.DateTimeFormat("en", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(profile.created_at));
  const location = profile.location || "GitHub";

  const profileBadges = [
    `<a href="https://github.com/${username}?tab=followers">${image(
      `https://img.shields.io/github/followers/${username}?style=flat-square&label=Followers&color=0969da`,
      "GitHub followers",
    )}</a>`,
    `<a href="https://github.com/${username}?tab=repositories">${image(
      `https://img.shields.io/github/stars/${username}?affiliations=OWNER&style=flat-square&label=Stars&color=0969da`,
      "GitHub stars",
    )}</a>`,
    image(
      shieldBadge(location, "", "flat-square", { color: "E30A17" }),
      `Based in ${location}`,
    ),
    image(
      shieldBadge("GitHub since", joinedDate, "flat-square", {
        color: "181717",
        logo: "github",
      }),
      `GitHub member since ${joinedDate}`,
    ),
  ];

  const languageBadges = languages.slice(0, 12).map(languageBadge);
  const technologyBadges = technologies.map(technologyBadge);

  return `<!--
  This file is generated by scripts/generate-profile.mjs.
  Edit the generator, not README.md. The scheduled workflow only commits when data changes.
-->

<div align="center">
  <a href="${profile.html_url}">
    <img src="${escapeHtml(profile.avatar_url)}" width="112" alt="${displayName}" />
  </a>

  <h1>${displayName}</h1>

  <p><strong>${tagline}</strong></p>

  <p>
    ${profileBadges.join("\n    ")}
  </p>
</div>

## GitHub Snapshot

${renderStats(profile, repositories, graphData)}

## Languages

Automatically calculated from GitHub's language data for my current public, non-fork, non-archived repositories.

${renderBadges(languageBadges)}

## Detected Toolkit

${
  technologyBadges.length > 0
    ? renderBadges(technologyBadges)
    : "Tooling will appear here as it is detected in public repositories."
}

## GitHub Achievements

${renderAchievements(achievements)}

## Recent Public Activity

${renderRecentActivity(activity)}
`;
}

async function main() {
  const [profile, publicRepositories, graphData, achievements, activity] =
    await Promise.all([
      getJson(`/users/${encodeURIComponent(username)}`),
      listPublicRepositories(),
      getProfileGraphData(),
      getAchievements(),
      getRecentActivity(),
    ]);

  const originalRepositories = publicRepositories.filter(
    (repository) =>
      !repository.fork &&
      !repository.archived &&
      repository.name.toLowerCase() !== username.toLowerCase(),
  );
  const repositories = await attachLanguages(originalRepositories);
  const languages = aggregateLanguages(repositories);
  const technologies = await detectTechnologies(repositories);
  const readme = buildReadme({
    profile,
    repositories,
    graphData,
    languages,
    technologies,
    achievements,
    activity,
  });

  await writeFile(outputPath, readme, "utf8");
  console.log(`Generated ${path.relative(process.cwd(), outputPath)} for ${username}.`);
}

await main();
