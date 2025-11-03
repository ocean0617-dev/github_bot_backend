const GitHubAPI = require('./githubApi');
const { extractEmailFromUser } = require('./emailFilter');
const Email = require('../models/Email');
const Repository = require('../models/Repository');

/**
 * Collect emails from GitHub repository contributors and commits
 */
class EmailCollector {
  constructor(githubToken, io = null) {
    this.githubAPI = new GitHubAPI(githubToken);
    this.io = io;
  }

  /**
   * Emit progress update to connected clients
   */
  emitProgress(data) {
    if (this.io) {
      this.io.emit('collection-progress', data);
    }
  }

  /**
   * Parse repository URL or owner/repo string
   */
  parseRepository(repoInput) {
    let owner, repo;
    
    if (repoInput.includes('/')) {
      if (repoInput.startsWith('http')) {
        // Full URL
        const match = repoInput.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (match) {
          owner = match[1];
          repo = match[2].replace(/\.git$/, '').replace(/\/$/, '');
        }
      } else {
        // owner/repo format
        const parts = repoInput.split('/');
        owner = parts[0];
        repo = parts[1];
      }
    } else {
      throw new Error('Invalid repository format. Use "owner/repo" or full GitHub URL');
    }

    return { owner, repo };
  }

  /**
   * Collect emails from contributors
   */
  async collectFromContributors(owner, repo) {
    const emails = [];
    let page = 1;
    let hasMore = true;
    let totalContributorsFetched = 0;
    const repositoryName = `${owner}/${repo}`;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 3;
    const maxPages = 1000; // Safety limit to prevent infinite loops (1000 pages = 100,000 contributors max)

    this.emitProgress({
      stage: 'contributors',
      message: `Fetching contributors for ${repositoryName}...`,
      page
    });

    let consecutiveEmptyPages = 0;
    const maxConsecutiveEmptyPages = 3; // Reduced to 3 - stop after 3 consecutive empty pages to be more aggressive
    
    while (hasMore && page <= maxPages) {
      try {
        // Use the new method that returns pagination info
        const { contributors, hasNextPage, linkHeader, nextPageUrl } = await this.githubAPI.getContributorsWithPagination(owner, repo, page, 100);
        
        // Safety check: if we've hit max pages, warn and stop
        if (page >= maxPages) {
          console.warn(`[Collector] Reached maximum page limit (${maxPages}). Stopping pagination to prevent infinite loop.`);
          console.warn(`[Collector] Total contributors fetched: ${totalContributorsFetched}. There may be more contributors.`);
          hasMore = false;
          break;
        }

        const contributorCount = contributors?.length || 0;
        
        // Track consecutive empty pages
        if (contributorCount === 0) {
          consecutiveEmptyPages++;
          console.log(`[Collector] Page ${page} returned 0 contributors. Consecutive empty pages: ${consecutiveEmptyPages}/${maxConsecutiveEmptyPages}`);
        } else {
          consecutiveEmptyPages = 0; // Reset counter on non-empty page
          totalContributorsFetched += contributorCount;
        }
        
        console.log(`[Collector] Page ${page}: Processing ${contributorCount} contributors (Total so far: ${totalContributorsFetched}), hasNextPage: ${hasNextPage}`);
        if (linkHeader) {
          console.log(`[Collector] Link header details: ${linkHeader}`);
        }
        if (nextPageUrl) {
          console.log(`[Collector] Next page would be: ${nextPageUrl}`);
        }

        this.emitProgress({
          stage: 'contributors',
          message: `Processing ${contributorCount} contributors (page ${page}, total fetched: ${totalContributorsFetched})...`,
          page,
          total: contributorCount,
          totalFetched: totalContributorsFetched
        });

        // Only process contributors if we have any
        if (contributorCount > 0) {
          // Process contributors in parallel (with concurrency limit)
          const batchSize = 5;
          for (let i = 0; i < contributors.length; i += batchSize) {
            const batch = contributors.slice(i, i + batchSize);
            const promises = batch.map(async (contributor) => {
              try {
                // Handle anonymous contributors (they don't have a login field)
                if (!contributor.login) {
                  // Anonymous contributor - check if email is directly available
                  // Note: Anonymous contributors might not have email in the response
                  // We still try to get user details using their ID if possible
                  if (contributor.email) {
                    const emailData = {
                      email: contributor.email.toLowerCase().trim(),
                      name: contributor.name || 'Anonymous Contributor',
                      username: '',
                      repository: repositoryName
                    };
                    const { filterInvalidEmails } = require('./emailFilter');
                    if (filterInvalidEmails(emailData.email)) {
                      return emailData;
                    }
                  }
                  return null;
                }
                
                // Regular contributor with login - get user details to check for public email
                const user = await this.githubAPI.getUser(contributor.login);
                const emailData = extractEmailFromUser(user);
                
                // Note: If no email from user profile, the commit collection phase will try to find
                // their email from commit authors. Many GitHub users have private emails that
                // aren't accessible via the /users endpoint.
                
                if (emailData) {
                  emailData.repository = repositoryName;
                  return emailData;
                }
                // Contributor exists but has no public email - will be caught in commit collection phase
                return null;
              } catch (error) {
                console.error(`Error fetching user ${contributor.login || 'anonymous'}:`, error.message);
                return null;
              }
            });

            const results = await Promise.all(promises);
            emails.push(...results.filter(e => e !== null));

            this.emitProgress({
              stage: 'contributors',
              message: `Processed batch ${Math.floor(i / batchSize) + 1} of page ${page}`,
              collected: emails.length,
              totalFetched: totalContributorsFetched
            });
          }
        }

        // Reset error counter on successful page
        consecutiveErrors = 0;

        // Check if there are more pages
        // Strategy:
        // 1. If Link header says there's a next page, always continue
        // 2. If we got fewer than 100 contributors, continue to check next page (don't assume it's the last page)
        // 3. If we got 0 contributors, continue but track consecutive empty pages
        // 4. Only stop if we've hit multiple consecutive empty pages OR Link header explicitly says no more
        
        // Stop if we've hit too many consecutive empty pages
        if (consecutiveEmptyPages >= maxConsecutiveEmptyPages) {
          console.log(`[Collector] ⚠️ Stopping after ${consecutiveEmptyPages} consecutive empty pages. Completed at page ${page - 1}. Total contributors fetched: ${totalContributorsFetched}`);
          hasMore = false;
        } else if (hasNextPage) {
          // Link header explicitly says there's a next page
          console.log(`[Collector] ✅ Link header indicates next page exists. Moving to page ${page + 1}`);
          page++;
        } else if (contributorCount === 0) {
          // Got 0 contributors but haven't hit max consecutive empty pages yet - continue
          console.log(`[Collector] ⚠️ Got 0 contributors on page ${page}. Continuing to check next page (${consecutiveEmptyPages}/${maxConsecutiveEmptyPages} consecutive empty pages).`);
          page++;
        } else if (contributorCount < 100) {
          // Got fewer than 100 contributors - continue to check if there are more
          // For large repos, GitHub might not send Link header even when more pages exist
          // So we continue checking until we hit multiple empty pages
          console.log(`[Collector] ⚠️ Got ${contributorCount} contributors (fewer than 100) but no Link header. Continuing to page ${page + 1} to check for more (safety: will check up to 5 more pages).`);
          page++;
        } else {
          // Got exactly 100 contributors - definitely continue
          console.log(`[Collector] ✅ Got full page (${contributorCount} contributors). Moving to page ${page + 1}.`);
          page++;
        }
        
        // Additional check: if we got 100 items but no next page indicator, log a warning
        if (contributorCount === 100 && !hasNextPage) {
          console.warn(`[Collector] ⚠️ WARNING: Got exactly 100 contributors but no Link header for next page. This might indicate GitHub API pagination issue. Will continue to check next page anyway.`);
        }

        // Small delay to avoid hitting rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        consecutiveErrors++;
        console.error(`[Collector] Error fetching contributors page ${page}:`, error.message);
        console.error(`[Collector] Consecutive errors: ${consecutiveErrors}/${maxConsecutiveErrors}`);
        
        if (error.message.includes('rate limit')) {
          console.error(`[Collector] Rate limit hit. Stopping.`);
          throw error;
        }
        
        // Only stop if we've had too many consecutive errors
        if (consecutiveErrors >= maxConsecutiveErrors) {
          console.error(`[Collector] Too many consecutive errors (${consecutiveErrors}). Stopping pagination.`);
          hasMore = false;
        } else {
          // Wait a bit and try again
          console.log(`[Collector] Retrying page ${page} after error...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          // Don't increment page, retry same page
        }
      }
    }

    const emailsFound = emails.length;
    const emailsNotFound = totalContributorsFetched - emailsFound;
    const emailCoverage = totalContributorsFetched > 0 ? ((emailsFound / totalContributorsFetched) * 100).toFixed(1) : 0;
    
    console.log(`[Collector] ✅ Finished collecting contributors.`);
    console.log(`[Collector] 📊 Summary: Processed ${page - 1} pages`);
    console.log(`[Collector] 📊 Contributors: ${totalContributorsFetched} total, ${emailsFound} with emails (${emailCoverage}%), ${emailsNotFound} without public emails`);
    console.log(`[Collector] ℹ️  Note: Contributors without public emails may be found in the commit collection phase.`);
    
    // Final warning if we might have missed some
    if (totalContributorsFetched < 1000 && page < 20) {
      console.warn(`[Collector] ⚠️  WARNING: Only fetched ${totalContributorsFetched} contributors but stopped at page ${page - 1}.`);
      console.warn(`[Collector] This might indicate GitHub API limitations or pagination issues. Check logs above for details.`);
    }
    
    return emails;
  }

  /**
   * Collect emails from commit authors
   */
  async collectFromCommits(owner, repo, maxCommits = 1000) {
    const emails = [];
    let page = 1;
    let hasMore = true;
    let totalCommits = 0;
    const repositoryName = `${owner}/${repo}`;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 3;

    this.emitProgress({
      stage: 'commits',
      message: `Fetching commits for ${repositoryName}...`,
      page
    });

    while (hasMore && totalCommits < maxCommits) {
      try {
        const commits = await this.githubAPI.getCommits(owner, repo, page);
        
        if (!commits || commits.length === 0) {
          hasMore = false;
          break;
        }

        this.emitProgress({
          stage: 'commits',
          message: `Processing ${commits.length} commits (page ${page})...`,
          page,
          total: commits.length
        });

        for (const commit of commits) {
          if (totalCommits >= maxCommits) break;

          const author = commit.commit?.author;
          if (author && author.email) {
            const emailData = {
              email: author.email.toLowerCase().trim(),
              name: author.name || commit.author?.login || '',
              username: commit.author?.login || ''
            };

            if (this.isValidEmail(emailData.email)) {
              emailData.repository = repositoryName;
              emails.push(emailData);
            }
          }

          totalCommits++;
        }

        // Reset error counter on successful page
        consecutiveErrors = 0;

        if (commits.length < 100) {
          hasMore = false;
        } else {
          page++;
        }

        // Small delay to avoid hitting rate limits and reduce connection issues
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        consecutiveErrors++;
        const errorMessage = error.message || error.toString();
        console.error(`Error fetching commits page ${page}:`, errorMessage);
        console.error(`Consecutive errors: ${consecutiveErrors}/${maxConsecutiveErrors}`);
        
        // Check if it's a rate limit error - always throw these
        if (errorMessage.includes('rate limit')) {
          console.error(`Rate limit hit. Stopping.`);
          throw error;
        }
        
        // Check if it's a transient network error (ECONNRESET, ETIMEDOUT, etc.)
        const isTransientError = 
          errorMessage.includes('ECONNRESET') ||
          errorMessage.includes('ETIMEDOUT') ||
          errorMessage.includes('ENOTFOUND') ||
          errorMessage.includes('ECONNREFUSED') ||
          errorMessage.includes('socket hang up') ||
          (error.code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(error.code));
        
        // Only stop if we've had too many consecutive errors
        if (consecutiveErrors >= maxConsecutiveErrors) {
          console.error(`Too many consecutive errors (${consecutiveErrors}). Stopping pagination.`);
          hasMore = false;
        } else if (isTransientError) {
          // Retry transient errors with exponential backoff
          const backoffDelay = Math.min(2000 * Math.pow(2, consecutiveErrors - 1), 30000); // Max 30 seconds
          console.log(`Transient network error detected. Retrying page ${page} after ${backoffDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          // Don't increment page, retry same page
        } else {
          // For other errors, wait a bit and then stop or retry based on error type
          console.log(`Error occurred. Waiting before retry...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          // For non-transient errors, increment page to continue
          if (consecutiveErrors < maxConsecutiveErrors) {
            page++;
          } else {
            hasMore = false;
          }
        }
      }
    }

    return emails;
  }

  /**
   * Quick email validation
   */
  isValidEmail(email) {
    if (!email) return false;
    const invalidPatterns = ['noreply', 'no-reply', 'example', 'test', 'github.com'];
    const lowerEmail = email.toLowerCase();
    return !invalidPatterns.some(pattern => lowerEmail.includes(pattern));
  }

  /**
   * Save emails to database with duplicate prevention
   */
  async saveEmails(emailList) {
    const saved = [];
    const duplicates = [];
    const errors = [];

    for (const emailData of emailList) {
      try {
        const existingEmail = await Email.findOne({ email: emailData.email });
        
        if (existingEmail) {
          duplicates.push(emailData.email);
          continue;
        }

        const email = new Email(emailData);
        await email.save();
        saved.push(email);
      } catch (error) {
        if (error.code === 11000) {
          // Duplicate key error
          duplicates.push(emailData.email);
        } else {
          errors.push({ email: emailData.email, error: error.message });
        }
      }
    }

    return { saved, duplicates, errors };
  }

  /**
   * Collect all emails from a repository
   */
  async collectFromRepository(repoInput, options = {}) {
    const { owner, repo } = this.parseRepository(repoInput);
    const repositoryName = `${owner}/${repo}`;
    
    const includeContributors = options.includeContributors !== false;
    const includeCommits = options.includeCommits !== false;
    const maxCommits = options.maxCommits || 1000;

    this.emitProgress({
      stage: 'start',
      message: `Starting email collection for ${repositoryName}...`
    });

    let allEmails = [];
    const emailMap = new Map(); // Use Map to deduplicate

    // Collect from contributors
    if (includeContributors) {
      try {
        const contributorEmails = await this.collectFromContributors(owner, repo);
        contributorEmails.forEach(email => {
          emailMap.set(email.email, email);
        });
        allEmails = Array.from(emailMap.values());
        
        this.emitProgress({
          stage: 'contributors-complete',
          message: `Found ${contributorEmails.length} emails from contributors`,
          collected: allEmails.length
        });
      } catch (error) {
        console.error('Error collecting from contributors:', error);
        this.emitProgress({
          stage: 'error',
          message: `Error collecting from contributors: ${error.message}`
        });
      }
    }

    // Collect from commits
    if (includeCommits) {
      try {
        const commitEmails = await this.collectFromCommits(owner, repo, maxCommits);
        commitEmails.forEach(email => {
          if (!emailMap.has(email.email)) {
            emailMap.set(email.email, email);
          }
        });
        allEmails = Array.from(emailMap.values());
        
        this.emitProgress({
          stage: 'commits-complete',
          message: `Found ${commitEmails.length} emails from commits`,
          collected: allEmails.length
        });
      } catch (error) {
        console.error('Error collecting from commits:', error);
        this.emitProgress({
          stage: 'error',
          message: `Error collecting from commits: ${error.message}`
        });
      }
    }

    // Filter emails
    const { filterInvalidEmails } = require('./emailFilter');
    const validEmails = allEmails.filter(email => filterInvalidEmails(email.email));
    
    this.emitProgress({
      stage: 'filtering',
      message: `Filtered to ${validEmails.length} valid emails`,
      collected: validEmails.length
    });

    // Save to database
    this.emitProgress({
      stage: 'saving',
      message: `Saving ${validEmails.length} emails to database...`
    });

    const result = await this.saveEmails(validEmails);

    // Update repository tracking
    await Repository.findOneAndUpdate(
      { repository: repositoryName },
      {
        $set: {
          totalEmails: validEmails.length,
          collectedAt: new Date()
        },
        $setOnInsert: {
          repository: repositoryName,
          sendHistory: []
        }
      },
      { upsert: true, new: true }
    );

    this.emitProgress({
      stage: 'complete',
      message: `Collection complete! Saved ${result.saved.length} new emails, ${result.duplicates.length} duplicates skipped`,
      saved: result.saved.length,
      duplicates: result.duplicates.length
    });

    return {
      repository: repositoryName,
      totalCollected: allEmails.length,
      validEmails: validEmails.length,
      saved: result.saved.length,
      duplicates: result.duplicates.length,
      errors: result.errors.length,
      emails: result.saved
    };
  }
}

module.exports = EmailCollector;
