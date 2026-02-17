/**
 * Normalize group name to prevent duplicates from different casing and spacing
 * Examples:
 *   "gw06", "Gw06", "gw 06", "GW 06" → "gw06"
 *   "Design 12", "design12", "DESIGN 12" → "design12"
 *   "Web 5", "web5", "WEB 5" → "web5"
 *
 * @param {string} groupName - The group name to normalize
 * @returns {string} - Normalized group name (lowercase, no spaces)
 */
function normalizeGroupName(groupName) {
  return String(groupName || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

module.exports = { normalizeGroupName };
