const axios = require('axios');

class GitHubAPI {
  constructor(token) {
    this.token = token;
    this.baseURL = 'https://api.github.com';
    this.rateLimitRemaining = 5000;
    this.rateLimitReset = Date.now() + 3600000; // Initialize to 1 hour from now (GitHub rate limit resets hourly)
  }

  /**
   * Make a request to GitHub API with rate limit handling
   */
  async request(endpoint, retries = 3, returnFullResponse = false) {
    const url = `${this.baseURL}${endpoint}`;
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'GitHub-Email-Collector'
    };

    if (this.token) {
      headers['Authorization'] = `token ${this.token}`;
    }

    try {
      // Check rate limit - only wait if we're actually at the limit or very close
      // Don't wait if we have > 10 remaining and haven't received actual rate limit info yet
      const hasValidRateLimitInfo = this.rateLimitReset > Date.now() + 1000; // Reset time should be in the future
      
      if (this.rateLimitRemaining <= 10 && hasValidRateLimitInfo) {
        const waitTime = Math.max(0, this.rateLimitReset - Date.now());
        if (waitTime > 0 && waitTime < 3600000) { // Only wait if less than 1 hour
          const waitSeconds = Math.ceil(waitTime / 1000);
          console.log(`⚠️ Rate limit very low (${this.rateLimitRemaining} remaining). Waiting ${waitSeconds} seconds until reset...`);
          await new Promise(resolve => setTimeout(resolve, waitTime + 2000)); // Add 2 second buffer
          // Reset rate limit after waiting - will be updated from API response
          this.rateLimitRemaining = 5000;
        }
      } else if (this.rateLimitRemaining < 50 && hasValidRateLimitInfo) {
        // Log warning but don't wait - just slow down requests
        console.log(`⚠️ Rate limit low (${this.rateLimitRemaining} remaining). Continuing but be aware of rate limits.`);
      }

      // Configure axios with timeout and better error handling
      const axiosConfig = {
        headers,
        timeout: 60000, // 60 second timeout to prevent hanging connections
        validateStatus: function (status) {
          return status >= 200 && status < 300; // Default behavior
        }
      };

      const response = await axios.get(url, axiosConfig);
      
      // Update rate limit info from headers
      if (response.headers['x-ratelimit-remaining']) {
        this.rateLimitRemaining = parseInt(response.headers['x-ratelimit-remaining']);
      }
      if (response.headers['x-ratelimit-reset']) {
        this.rateLimitReset = parseInt(response.headers['x-ratelimit-reset']) * 1000;
      }

      if (returnFullResponse) {
        // Axios lowercases header names, so 'Link' becomes 'link'
        return {
          data: response.data,
          headers: response.headers,
          status: response.status
        };
      }

      return response.data;
    } catch (error) {
      // Handle network errors (ECONNRESET, ETIMEDOUT, etc.)
      const isNetworkError = 
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        error.code === 'ECONNREFUSED' ||
        error.message?.includes('ECONNRESET') ||
        error.message?.includes('ETIMEDOUT') ||
        error.message?.includes('socket hang up') ||
        error.message?.includes('timeout');

      if (isNetworkError && retries > 0) {
        // Retry network errors with exponential backoff
        const backoffDelay = Math.min(2000 * Math.pow(2, 3 - retries), 10000); // Max 10 seconds
        console.log(`⚠️ Network error (${error.code || error.message}). Retrying in ${backoffDelay}ms... (${retries} retries left)`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
        return this.request(endpoint, retries - 1, returnFullResponse);
      }

      if (error.response) {
        // Handle rate limit error - improved handling
        const remaining = error.response.headers['x-ratelimit-remaining'];
        if (error.response.status === 403 && (remaining === '0' || parseInt(remaining) <= 0)) {
          const resetTime = parseInt(error.response.headers['x-ratelimit-reset']) * 1000;
          const waitTime = Math.max(0, resetTime - Date.now());
          
          if (retries > 0 && waitTime < 3600000) { // Retry if wait time is less than 1 hour
            const waitSeconds = Math.ceil(waitTime / 1000);
            console.log(`⏳ Rate limit exceeded. Waiting ${waitSeconds} seconds until reset at ${new Date(resetTime).toLocaleString()}...`);
            await new Promise(resolve => setTimeout(resolve, waitTime + 2000)); // Add 2 second buffer
            // Reset rate limit after waiting
            this.rateLimitRemaining = 5000;
            return this.request(endpoint, retries - 1, returnFullResponse);
          }
          
          throw new Error(`GitHub API rate limit exceeded. Reset at ${new Date(resetTime).toLocaleString()}. Please wait and try again.`);
        }
        
        throw new Error(`GitHub API error: ${error.response.status} - ${error.response.data?.message || error.message}`);
      }
      
      // Re-throw network errors if all retries exhausted
      if (isNetworkError) {
        throw new Error(`Network error after retries: ${error.code || error.message}`);
      }
      
      throw error;
    }
  }

  /**
   * Parse Link header to check if there are more pages
   * Link header format: <https://api.github.com/...>; rel="next", <https://...>; rel="prev"
   */
  hasNextPage(linkHeader) {
    if (!linkHeader) return false;
    // Link header can be lowercase 'link' or 'Link', handle both
    const link = typeof linkHeader === 'string' ? linkHeader : (linkHeader['link'] || linkHeader['Link'] || '');
    
    // More robust parsing: check for rel="next" or rel='next'
    // GitHub's Link header uses rel="next" (with double quotes)
    // Also handle cases where links are separated by commas
    const nextRegex = /rel=["']next["']/i;
    return nextRegex.test(link);
  }

  /**
   * Extract next page URL from Link header
   */
  getNextPageUrl(linkHeader) {
    if (!linkHeader) return null;
    const link = typeof linkHeader === 'string' ? linkHeader : (linkHeader['link'] || linkHeader['Link'] || '');
    
    // Parse Link header: <url>; rel="next"
    const nextMatch = link.match(/<([^>]+)>;\s*rel=["']next["']/i);
    return nextMatch ? nextMatch[1] : null;
  }

  /**
   * Get repository contributors
   */
  async getContributors(owner, repo, page = 1, perPage = 100) {
    const endpoint = `/repos/${owner}/${repo}/contributors?page=${page}&per_page=${perPage}&anon=1`;
    return await this.request(endpoint);
  }

  /**
   * Get repository contributors with pagination info
   * Includes anonymous contributors using anon=1 parameter
   */
  async getContributorsWithPagination(owner, repo, page = 1, perPage = 100) {
    const endpoint = `/repos/${owner}/${repo}/contributors?page=${page}&per_page=${perPage}&anon=1`;
    const response = await this.request(endpoint, 3, true);
    
    // Axios lowercases all header names, so 'Link' becomes 'link'
    const linkHeader = response.headers.link || response.headers['link'] || '';
    const hasNext = this.hasNextPage(linkHeader);
    const contributorCount = response.data?.length || 0;
    const nextPageUrl = this.getNextPageUrl(linkHeader);
    
    console.log(`[GitHub API] Page ${page}: Got ${contributorCount} contributors, hasNextPage: ${hasNext}`);
    
    if (linkHeader) {
      console.log(`[GitHub API] Link header: ${linkHeader}`);
      if (nextPageUrl) {
        console.log(`[GitHub API] Next page URL: ${nextPageUrl}`);
      }
    } else {
      console.log(`[GitHub API] No Link header found. Response status: ${response.status}`);
      // If no link header and we got fewer than perPage items, assume no more pages
      if (contributorCount < perPage) {
        console.log(`[GitHub API] Got ${contributorCount} < ${perPage} items, likely last page`);
      } else if (contributorCount === perPage) {
        console.log(`[GitHub API] Got exactly ${perPage} items but no Link header - will check next page to confirm`);
      }
    }
    
    // Check response headers for pagination info
    if (response.headers['x-total-count']) {
      const totalCount = parseInt(response.headers['x-total-count']);
      console.log(`[GitHub API] Total contributors according to X-Total-Count header: ${totalCount}`);
    }
    
    return {
      contributors: response.data,
      hasNextPage: hasNext,
      linkHeader: linkHeader,
      contributorCount: contributorCount,
      nextPageUrl: nextPageUrl
    };
  }

  /**
   * Get user details (including email if public)
   */
  async getUser(username) {
    const endpoint = `/users/${username}`;
    return await this.request(endpoint);
  }

  /**
   * Get commits for a repository
   */
  async getCommits(owner, repo, page = 1, perPage = 100) {
    const endpoint = `/repos/${owner}/${repo}/commits?page=${page}&per_page=${perPage}`;
    return await this.request(endpoint);
  }

  /**
   * Get commit author details
   */
  async getCommit(owner, repo, sha) {
    const endpoint = `/repos/${owner}/${repo}/commits/${sha}`;
    return await this.request(endpoint);
  }

  /**
   * Get rate limit status
   */
  getRateLimitStatus() {
    return {
      remaining: this.rateLimitRemaining,
      resetAt: new Date(this.rateLimitReset).toLocaleString()
    };
  }
}

module.exports = GitHubAPI;
