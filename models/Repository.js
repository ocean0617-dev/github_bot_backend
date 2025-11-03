const mongoose = require('mongoose');

// Schema for tracking repository sending history
const repositorySendHistorySchema = new mongoose.Schema({
  sender: {
    type: String,
    required: true,
    enum: ['outlook', 'gmail'],
    lowercase: true
  },
  senderEmail: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },
  sentCount: {
    type: Number,
    required: true,
    default: 0
  },
  sentAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const repositorySchema = new mongoose.Schema({
  repository: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  totalEmails: {
    type: Number,
    default: 0
  },
  sendHistory: {
    type: [repositorySendHistorySchema],
    default: []
  },
  lastSentAt: {
    type: Date
  },
  collectedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: false
});

// Index for faster queries
repositorySchema.index({ repository: 1 });
repositorySchema.index({ 'sendHistory.sender': 1 });
repositorySchema.index({ lastSentAt: -1 });

module.exports = mongoose.model('Repository', repositorySchema);

