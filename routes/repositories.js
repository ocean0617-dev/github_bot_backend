const express = require('express');
const router = express.Router();
const Repository = require('../models/Repository');
const Email = require('../models/Email');

/**
 * GET /api/repositories
 * Get all repositories with stats
 */
router.get('/', async (req, res) => {
  try {
    const repositories = await Repository.find({}).sort({ lastSentAt: -1 });
    
    // Get total email count for each repository
    const reposWithStats = await Promise.all(
      repositories.map(async (repo) => {
        const emailCount = await Email.countDocuments({ repository: repo.repository });
        return {
          ...repo.toObject(),
          totalEmails: emailCount
        };
      })
    );
    
    res.json(reposWithStats);
  } catch (error) {
    console.error('Error fetching repositories:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/repositories/:repository
 * Get specific repository details
 */
router.get('/:repository', async (req, res) => {
  try {
    const repositoryName = decodeURIComponent(req.params.repository);
    const repository = await Repository.findOne({ repository: repositoryName });
    
    if (!repository) {
      return res.status(404).json({ error: 'Repository not found' });
    }
    
    const emailCount = await Email.countDocuments({ repository: repositoryName });
    
    res.json({
      ...repository.toObject(),
      totalEmails: emailCount
    });
  } catch (error) {
    console.error('Error fetching repository:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/repositories/:repository
 * Delete a repository and all associated emails
 */
router.delete('/:repository', async (req, res) => {
  try {
    const repositoryName = decodeURIComponent(req.params.repository);
    
    // Delete the repository
    const repository = await Repository.findOneAndDelete({ repository: repositoryName });
    
    if (!repository) {
      return res.status(404).json({ error: 'Repository not found' });
    }
    
    // Delete all emails associated with this repository
    const deleteResult = await Email.deleteMany({ repository: repositoryName });
    
    // Emit real-time update
    const io = req.app.get('io');
    if (io) {
      io.emit('repository-deleted', { repository: repositoryName });
    }
    
    res.json({
      message: 'Repository and associated emails deleted',
      repository: repositoryName,
      emailsDeleted: deleteResult.deletedCount
    });
  } catch (error) {
    console.error('Error deleting repository:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

