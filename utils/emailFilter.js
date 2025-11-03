/**
 * Email validation patterns (comprehensive patterns from working implementation)
 */
const NOREPLY_PATTERN = /noreply@|users\.noreply\.github\.com/i;
const EXAMPLE_PATTERN = /example\.com|test\.com|sample\.com|demo\.com/i;
const GENERIC_PATTERN = /admin@|info@|contact@|hello@|noreply@|no-reply@|donotreply@/i;
const TEST_PATTERN = /test@|testing@|dev@|development@|staging@|qa@/i;
const TEMP_PATTERN = /temp@|temporary@|tmp@|temp-|tmp-/i;
const GITHUB_PATTERN = /github\.com|github\.local|ghp_|users\.noreply/i;
const INVALID_PATTERN = /localhost|invalid|fake|placeholder/i;

/**
 * Filter out non-real emails (enhanced with regex patterns)
 */
const filterInvalidEmails = (email) => {
  if (!email || typeof email !== 'string') {
    return false;
  }

  // Basic email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return false;
  }

  const lowerEmail = email.toLowerCase().trim();

  // Check for common non-real email patterns using regex
  if (NOREPLY_PATTERN.test(lowerEmail)) return false;
  if (EXAMPLE_PATTERN.test(lowerEmail)) return false;
  if (GENERIC_PATTERN.test(lowerEmail)) return false;
  if (TEST_PATTERN.test(lowerEmail)) return false;
  if (TEMP_PATTERN.test(lowerEmail)) return false;
  if (GITHUB_PATTERN.test(lowerEmail)) return false;
  if (INVALID_PATTERN.test(lowerEmail)) return false;

  // Check for generic email names
  const genericNames = ['example', 'test', 'sample', 'demo', 'admin', 'postmaster', 'noreply', 'no-reply'];
  const emailName = lowerEmail.split('@')[0];
  if (genericNames.includes(emailName)) {
    return false;
  }

  return true;
};

/**
 * Extract and validate email from GitHub user data
 */
const extractEmailFromUser = (user) => {
  if (!user || !user.email) {
    return null;
  }

  if (filterInvalidEmails(user.email)) {
    return {
      email: user.email.toLowerCase().trim(),
      name: user.name || user.login || '',
      username: user.login || ''
    };
  }

  return null;
};

module.exports = {
  filterInvalidEmails,
  extractEmailFromUser
};
