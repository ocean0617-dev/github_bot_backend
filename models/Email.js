const mongoose = require('mongoose');

// Schema for tracking email send history by sender
const emailSentSchema = new mongoose.Schema({
  sender: {
    type: String,
    required: true,
    enum: ['outlook', 'gmail'],
    lowercase: true
  },
  sentAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const emailSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  name: {
    type: String,
    default: ''
  },
  username: {
    type: String,
    default: ''
  },
  repository: {
    type: String,
    required: true
  },
  source: {
    type: String,
    enum: ['github', 'manual'],
    default: 'github'
  },
  collectedAt: {
    type: Date,
    default: Date.now
  },
  emailSent: {
    type: [emailSentSchema],
    default: []
  }
}, {
  timestamps: false // Removed timestamps as requested
});

// Index for faster queries
emailSchema.index({ email: 1 });
emailSchema.index({ repository: 1 });
emailSchema.index({ collectedAt: -1 });
emailSchema.index({ 'emailSent.sender': 1 });

module.exports = mongoose.model('Email', emailSchema);
