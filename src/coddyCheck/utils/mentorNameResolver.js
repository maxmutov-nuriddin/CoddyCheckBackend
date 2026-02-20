const User = require("../../models/User");

const STAFF_ROLES = ["mentor", "mentor_ta", "ta"];
const MIN_SCORE = 85;
const MIN_GAP = 2;

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bb`']/g, "'")
    .replace(/[^a-z0-9'\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  const normalized = normalizeName(value);
  return normalized ? normalized.split(" ").filter(Boolean) : [];
}

function roleBonus(role) {
  if (role === "mentor") return 3;
  if (role === "mentor_ta") return 2;
  if (role === "ta") return 1;
  return 0;
}

function scoreCandidate(inputNormalized, inputTokens, candidateNormalized, candidateTokens, role) {
  if (!inputNormalized || !candidateNormalized) return -1;

  let score = 0;

  if (candidateNormalized === inputNormalized) {
    score = 110;
  } else {
    if (candidateTokens.includes(inputNormalized)) score = Math.max(score, 102);
    if (candidateNormalized.startsWith(`${inputNormalized} `) || candidateNormalized.startsWith(inputNormalized)) {
      score = Math.max(score, 98);
    }
    if (
      candidateNormalized.includes(` ${inputNormalized} `) ||
      candidateNormalized.endsWith(` ${inputNormalized}`) ||
      candidateNormalized.includes(inputNormalized)
    ) {
      score = Math.max(score, 90);
    }

    if (inputTokens.length > 1) {
      const fullTokenMatch = inputTokens.every((token) =>
        candidateTokens.some((candidateToken) => candidateToken === token || candidateToken.startsWith(token))
      );
      if (fullTokenMatch) {
        score = Math.max(score, 100 + Math.min(inputTokens.length, 4));
      }
    }

    const tokenMatches = inputTokens.filter((token) =>
      candidateTokens.some((candidateToken) => candidateToken === token || candidateToken.startsWith(token))
    ).length;

    if (tokenMatches > 0) {
      score = Math.max(score, 70 + tokenMatches * 6);
    }
  }

  score += roleBonus(role);
  score -= Math.min(5, Math.abs(candidateNormalized.length - inputNormalized.length) / 4);

  return score;
}

function resolveMentorNameFromWorkers(rawName, workers = []) {
  const original = String(rawName || "").trim();
  if (!original) return original;

  const inputNormalized = normalizeName(original);
  const inputTokens = tokenize(original);
  if (!inputNormalized || inputTokens.length === 0) return original;

  let best = null;
  let second = null;

  for (const worker of workers) {
    const fullName = String(worker?.fullName || "").trim();
    if (!fullName) continue;

    const candidateNormalized = normalizeName(fullName);
    const candidateTokens = tokenize(fullName);
    const score = scoreCandidate(inputNormalized, inputTokens, candidateNormalized, candidateTokens, worker?.role);

    if (score < 0) continue;

    const candidate = { score, fullName };
    if (!best || candidate.score > best.score) {
      second = best;
      best = candidate;
    } else if (!second || candidate.score > second.score) {
      second = candidate;
    }
  }

  if (!best || best.score < MIN_SCORE) return original;
  if (second && best.score - second.score < MIN_GAP) return original;

  return best.fullName;
}

// ── Staff list cache ───────────────────────────────────────────────────
// Staff changes only on admin add/remove (very rare). Caching for 60s
// eliminates 3 redundant DB queries per dashboard refresh cycle.
// Display-only — does NOT affect attendance write paths or bot auth.
let _staffCache = null;
let _staffCacheExpiresAt = 0;
const STAFF_CACHE_TTL_MS = 60_000;

async function loadActiveStaffForMatching() {
  const now = Date.now();
  if (_staffCache && _staffCacheExpiresAt > now) {
    return _staffCache;
  }
  const staff = await User.find(
    { isActive: true, role: { $in: STAFF_ROLES } },
    { fullName: 1, role: 1, telegramId: 1 }
  ).lean();
  _staffCache = staff;
  _staffCacheExpiresAt = now + STAFF_CACHE_TTL_MS;
  return staff;
}

async function resolveMentorDisplayName(rawName, workers) {
  const staff = Array.isArray(workers) ? workers : await loadActiveStaffForMatching();
  return resolveMentorNameFromWorkers(rawName, staff);
}

module.exports = {
  loadActiveStaffForMatching,
  resolveMentorDisplayName,
  resolveMentorNameFromWorkers
};

