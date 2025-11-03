const express = require('express');
const router = express.Router();
const EmailCollector = require('../utils/emailCollector');

/**
 * POST /api/github/collect
 * Collect emails from a GitHub repository
 */
router.post('/collect', async (req, res) => {
  try {
    const { repository, options = {}, githubToken } = req.body;

    if (!repository) {
      return res.status(400).json({ error: 'Repository is required (format: owner/repo or full GitHub URL)' });
    }

    // Use token from request body, fallback to env variable if not provided (for backward compatibility)
    const token = githubToken || process.env.GITHUB_TOKEN || undefined;
    const io = req.app.get('io'); // Get socket.io instance

    const collector = new EmailCollector(token, io);
    
    // Run collection in background (don't await to avoid timeout)
    collector.collectFromRepository(repository, options)
      .then(result => {
        if (io) {
          io.emit('collection-complete', result);
        }
      })
      .catch(error => {
        console.error('Collection error:', error);
        if (io) {
          io.emit('collection-error', { error: error.message });
        }
      });

    res.json({ 
      message: 'Email collection started',
      repository,
      status: 'processing'
    });
  } catch (error) {
    console.error('Error starting collection:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/github/rate-limit
 * Get GitHub API rate limit status
 */
router.get('/rate-limit', async (req, res) => {
  try {
    const { token } = req.query;
    // Use token from query param, fallback to env variable if not provided
    const githubToken = token || process.env.GITHUB_TOKEN || undefined;
    const GitHubAPI = require('../utils/githubApi');
    const githubAPI = new GitHubAPI(githubToken);
    const status = githubAPI.getRateLimitStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
