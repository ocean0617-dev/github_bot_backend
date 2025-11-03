const express = require('express');
const router = express.Router();
const Email = require('../models/Email');
const { filterInvalidEmails } = require('../utils/emailFilter');

/**
 * GET /api/emails
 * Get all stored emails with pagination and filtering
 */
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const repository = req.query.repository;
    const search = req.query.search;
    const collectedFrom = req.query.collectedFrom;
    const collectedTo = req.query.collectedTo;

    const query = {};
    
    if (repository) {
      // Support partial matching for repository filter
      query.repository = { $regex: repository, $options: 'i' };
    }

    if (search) {
      query.$or = [
        { email: { $regex: search, $options: 'i' } },
        { name: { $regex: search, $options: 'i' } },
        { username: { $regex: search, $options: 'i' } }
      ];
    }

    // Date filtering for collectedAt
    if (collectedFrom || collectedTo) {
      query.collectedAt = {};
      if (collectedFrom) {
        query.collectedAt.$gte = new Date(collectedFrom);
      }
      if (collectedTo) {
        // Set to end of day for inclusive filtering
        const endDate = new Date(collectedTo);
        endDate.setHours(23, 59, 59, 999);
        query.collectedAt.$lte = endDate;
      }
    }

    const emails = await Email.find(query)
      .sort({ collectedAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Email.countDocuments(query);

    res.json({
      emails,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching emails:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/emails/stats
 * Get email statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const total = await Email.countDocuments();
    const byRepository = await Email.aggregate([
      {
        $group: {
          _id: '$repository',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    const recentCount = await Email.countDocuments({
      collectedAt: {
        $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
      }
    });

    res.json({
      total,
      recent24h: recentCount,
      byRepository
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/emails
 * Manually add an email
 */
router.post('/', async (req, res) => {
  try {
    const { email, name, username, repository } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (!filterInvalidEmails(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Check for duplicate
    const existing = await Email.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({ error: 'Email already exists', email: existing });
    }

    const newEmail = new Email({
      email: email.toLowerCase().trim(),
      name: name || '',
      username: username || '',
      repository: repository || 'manual',
      source: 'manual'
    });

    await newEmail.save();

    // Emit real-time update
    const io = req.app.get('io');
    if (io) {
      io.emit('email-added', newEmail);
    }

    res.status(201).json(newEmail);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Email already exists' });
    }
    console.error('Error adding email:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/emails/:id
 * Delete an email
 */
router.delete('/:id', async (req, res) => {
  try {
    const email = await Email.findByIdAndDelete(req.params.id);
    
    if (!email) {
      return res.status(404).json({ error: 'Email not found' });
    }

    // Emit real-time update
    const io = req.app.get('io');
    if (io) {
      io.emit('email-deleted', { id: req.params.id });
    }

    res.json({ message: 'Email deleted', email });
  } catch (error) {
    console.error('Error deleting email:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/emails
 * Bulk delete emails
 */
router.delete('/', async (req, res) => {
  try {
    const { ids, repository } = req.body;

    const query = {};
    if (ids && Array.isArray(ids)) {
      query._id = { $in: ids };
    } else if (repository) {
      query.repository = repository;
    } else {
      return res.status(400).json({ error: 'Provide ids array or repository' });
    }

    const result = await Email.deleteMany(query);

    // Emit real-time update
    const io = req.app.get('io');
    if (io) {
      io.emit('emails-bulk-deleted', { count: result.deletedCount });
    }

    res.json({ message: `${result.deletedCount} emails deleted`, deletedCount: result.deletedCount });
  } catch (error) {
    console.error('Error bulk deleting emails:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
