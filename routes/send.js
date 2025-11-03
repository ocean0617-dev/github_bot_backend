const express = require('express');
const router = express.Router();
const EmailSender = require('../utils/emailSender');
const Email = require('../models/Email');
const Repository = require('../models/Repository');
const { filterInvalidEmails } = require('../utils/emailFilter');

/**
 * Detect sender type from SMTP config (outlook or gmail)
 */
function detectSender(smtpConfig) {
  const host = (smtpConfig.host || '').toLowerCase();
  if (host.includes('outlook') || host.includes('office365') || host.includes('hotmail')) {
    return 'outlook';
  }
  if (host.includes('gmail') || host.includes('google')) {
    return 'gmail';
  }
  // Default to gmail if can't detect
  return 'gmail';
}

/**
 * POST /api/send/test
 * Test SMTP configuration
 * Accepts SMTP config from request body or falls back to environment variables
 */
router.post('/test', async (req, res) => {
  try {
    // Clean host: remove protocol prefixes (https://, http://, smtp://) and trim whitespace
    let host = req.body.host || process.env.SMTP_HOST;
    if (host) {
      host = host.trim().replace(/^https?:\/\//i, '').replace(/^smtp:\/\//i, '').trim();
    }
    
    const smtpConfig = {
      host: host,
      port: parseInt(req.body.port || process.env.SMTP_PORT) || 587,
      user: req.body.user || process.env.SMTP_USER,
      pass: req.body.pass || process.env.SMTP_PASS,
      from: req.body.from || process.env.SMTP_FROM || req.body.user || process.env.SMTP_USER,
      senderName: req.body.senderName || ''
    };

    if (!smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
      return res.status(400).json({ error: 'SMTP configuration is incomplete. Please provide host, user (email), and pass (password)' });
    }

    // Ensure "from" field is set
    if (!smtpConfig.from) {
      smtpConfig.from = smtpConfig.user;
    }

    const sender = new EmailSender(smtpConfig);
    const verification = await sender.verify();

    if (verification.success) {
      res.json({ success: true, message: 'SMTP configuration is valid' });
    } else {
      // Provide more helpful error messages
      let errorMessage = verification.message;
      
      // Error messages are now enhanced in EmailSender.verify()
      // Just pass them through, but add port-specific suggestions
      if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
        const port = smtpConfig.port;
        if (!errorMessage.includes('Possible causes')) {
          // Only add suggestion if not already enhanced
          if (port === 587) {
            errorMessage += '\n\n💡 Try: Switch to port 465 (SSL) or check firewall settings.';
          } else if (port === 465) {
            errorMessage += '\n\n💡 Try: Switch to port 587 (STARTTLS) or verify your network/firewall allows outbound SMTP connections.';
          }
        }
      }
      
      res.status(400).json({ error: errorMessage });
    }
  } catch (error) {
    let errorMessage = error.message;
    
    // Provide helpful error messages for common issues
    if (errorMessage.includes('ETIMEDOUT') || errorMessage.includes('timeout')) {
      const port = parseInt(req.body.port || process.env.SMTP_PORT) || 587;
      if (port === 587) {
        errorMessage += '. Try using port 465 (SSL) instead, or check your firewall/network settings.';
      } else if (port === 465) {
        errorMessage += '. Try using port 587 (STARTTLS) instead, or check your firewall/network settings.';
      }
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

/**
 * POST /api/send/single
 * Send email to a single address
 * DISABLED - This endpoint has been disabled
 */
// router.post('/single', async (req, res) => {
//   try {
//     const { to, subject, html, text, attachments } = req.body;

//     if (!to || !subject || !html) {
//       return res.status(400).json({ error: 'to, subject, and html are required' });
//     }

//     if (!filterInvalidEmails(to)) {
//       return res.status(400).json({ error: 'Invalid email address' });
//     }

//     const smtpConfig = {
//       host: process.env.SMTP_HOST,
//       port: parseInt(process.env.SMTP_PORT) || 587,
//       user: process.env.SMTP_USER,
//       pass: process.env.SMTP_PASS,
//       from: process.env.SMTP_FROM || process.env.SMTP_USER
//     };

//     const sender = new EmailSender(smtpConfig);
//     const result = await sender.sendEmail(to, subject, html, text, attachments || []);

//     if (result.success) {
//       res.json(result);
//     } else {
//       res.status(500).json({ error: result.error });
//     }
//   } catch (error) {
//     res.status(500).json({ error: error.message });
//   }
// });

/**
 * POST /api/send/bulk
 * Send bulk emails to stored contributors or custom list
 */
router.post('/bulk', async (req, res) => {
  try {
    const { 
      repository, 
      emailIds, 
      customEmails,
      subject, 
      htmlTemplate, 
      textTemplate,
      batchSize,
      delay,
      smtpConfig: requestSmtpConfig
    } = req.body;

    if (!subject || !htmlTemplate) {
      return res.status(400).json({ error: 'subject and htmlTemplate are required' });
    }

    // Get SMTP configuration from request body or fall back to environment variables
    // Clean host: remove protocol prefixes (https://, http://, smtp://) and trim whitespace
    let host = requestSmtpConfig?.host || process.env.SMTP_HOST;
    if (host) {
      host = host.trim().replace(/^https?:\/\//i, '').replace(/^smtp:\/\//i, '').trim();
    }
    
    const smtpConfig = requestSmtpConfig ? {
      host: host,
      port: parseInt(requestSmtpConfig.port) || 587,
      user: requestSmtpConfig.user,
      pass: requestSmtpConfig.pass,
      from: requestSmtpConfig.from || requestSmtpConfig.user,
      senderName: requestSmtpConfig.senderName || ''
    } : {
      host: host,
      port: parseInt(process.env.SMTP_PORT) || 587,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      senderName: ''
    };

    if (!smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
      return res.status(400).json({ error: 'SMTP configuration is required. Please provide SMTP settings in the form.' });
    }

    // Ensure "from" field is set
    if (!smtpConfig.from) {
      smtpConfig.from = smtpConfig.user;
    }

    let emails = [];
    let limitCount = null; // Per-repository limit

    // Get emails from database
    if (emailIds && Array.isArray(emailIds) && emailIds.length > 0) {
      emails = await Email.find({ _id: { $in: emailIds } });
    } else if (repository) {
      // Get emails for specific repository
      const query = { repository };
      
      // Filter by sender if excludeAlreadySent is enabled (exclude emails already sent by this sender)
      const excludeAlreadySent = requestSmtpConfig?.excludeAlreadySent === true;
      if (excludeAlreadySent) {
        const senderType = detectSender(smtpConfig);
        query[`emailSent.sender`] = { $ne: senderType };
      }
      
      emails = await Email.find(query);
      
      // Apply limit if specified (for per-repository sending)
      if (requestSmtpConfig?.limit && parseInt(requestSmtpConfig.limit) > 0) {
        limitCount = Math.min(parseInt(requestSmtpConfig.limit), 500); // Max 500 per send
        emails = emails.slice(0, limitCount);
      } else {
        // Default limit of 500 for repository sends
        limitCount = Math.min(emails.length, 500);
        emails = emails.slice(0, limitCount);
      }
    } else if (customEmails && Array.isArray(customEmails) && customEmails.length > 0) {
      // Use custom email list - handle both string array and object array
      emails = customEmails
        .map(e => {
          const emailStr = typeof e === 'string' ? e.trim() : (e.email || '').trim();
          return emailStr;
        })
        .filter(e => e && filterInvalidEmails(e))
        .map(e => ({
          email: e,
          name: '',
          username: '',
          repository: 'custom'
        }));
    } else {
      // Get all emails (but limit to 500 for safety)
      emails = await Email.find({}).limit(500);
    }

    if (emails.length === 0) {
      return res.status(400).json({ error: 'No emails found to send to' });
    }

    // Filter invalid emails - handle both object and string formats
    emails = emails.filter(e => {
      const emailAddress = e.email || e;
      return emailAddress && filterInvalidEmails(emailAddress);
    });

    if (emails.length === 0) {
      return res.status(400).json({ error: 'No valid emails to send to' });
    }

    // Get socket.io instance and pass to EmailSender for progress updates
    const io = req.app.get('io');
    const sender = new EmailSender(smtpConfig, io);
    
    // Send in background and emit progress
    sender.sendBulkEmails(
      emails, 
      subject, 
      htmlTemplate, 
      textTemplate,
      { batchSize: batchSize || 5, delay: delay || 1000 }
    )
    .then(async (results) => {
      // Detect sender type
      const senderType = detectSender(smtpConfig);
      const senderEmail = smtpConfig.user || smtpConfig.from || ''; // Get actual sender email
      
      // Update email records with sender tracking
      const sentEmails = results.sent.map(r => r.email);
      const now = new Date();
      
      // For each sent email, add sender info to emailSent array
      for (const emailAddress of sentEmails) {
        await Email.updateOne(
          { email: emailAddress },
          {
            $addToSet: {
              emailSent: {
                sender: senderType,
                senderEmail: senderEmail,
                sentAt: now
              }
            }
          }
        );
      }

      // Update repository monitoring
      const repositoryStats = {};
      
      // Group sent emails by repository
      for (const result of results.sent) {
        const emailRecord = emails.find(e => (e.email || e) === result.email);
        if (emailRecord && emailRecord.repository) {
          const repo = emailRecord.repository;
          if (!repositoryStats[repo]) {
            repositoryStats[repo] = 0;
          }
          repositoryStats[repo]++;
        }
      }

      // Update repository send history
      for (const [repoName, sentCount] of Object.entries(repositoryStats)) {
        await Repository.findOneAndUpdate(
          { repository: repoName },
          {
            $push: {
              sendHistory: {
                sender: senderType,
                senderEmail: senderEmail,
                sentCount: sentCount,
                sentAt: now
              }
            },
            $set: {
              lastSentAt: now
            },
            $setOnInsert: {
              repository: repoName,
              totalEmails: 0,
              collectedAt: now
            }
          },
          { upsert: true, new: true }
        );
      }

      if (io) {
        io.emit('bulk-send-complete', {
          total: results.total,
          sent: results.sent.length,
          failed: results.failed.length,
          sender: senderType
        });
      }
    })
    .catch(error => {
      console.error('❌ Bulk send error:', error.message);
      console.error('Error details:', error);
      
      // Provide helpful error messages (matching working implementation)
      let errorMessage = error.message;
      
      if (error.message.includes('SMTP connection')) {
        errorMessage = 'Failed to verify SMTP connection. Please check your SMTP configuration.';
      } else if (error.message.includes('authentication') || error.message.includes('EAUTH')) {
        errorMessage = 'SMTP authentication failed. Please check your email and password.';
      } else if (error.message.includes('timeout') || error.message.includes('ETIMEDOUT')) {
        errorMessage = 'Connection timeout. Please check your network connection and SMTP settings.';
      }
      
      if (io) {
        io.emit('bulk-send-error', { error: errorMessage });
      }
    });

    res.json({ 
      message: 'Bulk email sending started',
      totalEmails: emails.length,
      status: 'processing'
    });
  } catch (error) {
    console.error('Error starting bulk send:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/send/progress
 * Get sending progress (for future implementation)
 */
router.get('/progress', (req, res) => {
  // This would track progress in a more advanced implementation
  res.json({ message: 'Use WebSocket for real-time progress updates' });
});

/**
 * POST /api/send/test-connection
 * Test network connectivity to SMTP host and port
 */
router.post('/test-connection', async (req, res) => {
  try {
    const { host, port } = req.body;
    
    if (!host || !port) {
      return res.status(400).json({ error: 'host and port are required' });
    }

    // Clean host
    let cleanHost = host.trim().replace(/^https?:\/\//i, '').replace(/^smtp:\/\//i, '').trim();
    const testPort = parseInt(port) || 587;

    const net = require('net');
    
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const timeout = 10000; // 10 second timeout
      let resolved = false;
      
      // Helper function to detect VPN/corporate network
      // Checks for private IP ranges: 10.x.x.x, 172.16-31.x.x, 192.168.x.x, and 100.x.x.x (common VPN range)
      const detectNetworkType = (sourceIP) => {
        if (!sourceIP || sourceIP === 'unknown') {
          return { isVPN: false, detectedNetwork: 'Unknown network type' };
        }
        
        // Check for private IP ranges that commonly indicate VPN/corporate networks
        const isPrivateIP = sourceIP.startsWith('10.') || 
                           sourceIP.startsWith('192.168.') ||
                           sourceIP.startsWith('100.') || // Common VPN range
                           (sourceIP.startsWith('172.') && 
                            parseInt(sourceIP.split('.')[1]) >= 16 && 
                            parseInt(sourceIP.split('.')[1]) <= 31); // 172.16.0.0/12
        
        return {
          isVPN: isPrivateIP,
          detectedNetwork: isPrivateIP ? 'VPN/Corporate network detected' : 'Unknown network type'
        };
      };
      
      // Helper function to get VPN-specific suggestion
      const getSuggestion = (isVPN, defaultMsg) => {
        if (isVPN) {
          return 'You appear to be on a VPN or corporate network. These networks often block SMTP ports. Try: 1) Disconnect VPN, 2) Use mobile hotspot, or 3) Contact your IT admin to whitelist SMTP ports.';
        }
        return defaultMsg;
      };
      
      socket.setTimeout(timeout);
      
      socket.once('connect', () => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          res.json({ 
            success: true, 
            message: `✅ Port ${testPort} is reachable on ${cleanHost}`,
            host: cleanHost,
            port: testPort
          });
          resolve();
        }
      });
      
      socket.once('timeout', () => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          
          // Get source IP for network detection
          const sourceIP = socket.localAddress || 'unknown';
          const networkInfo = detectNetworkType(sourceIP);
          const suggestion = getSuggestion(
            networkInfo.isVPN,
            'Check your firewall settings or try a different network'
          );
          
          res.status(400).json({ 
            success: false,
            message: `❌ Connection timeout: Port ${testPort} is not reachable on ${cleanHost}. This usually means the port is blocked by a firewall or the host is incorrect.`,
            host: cleanHost,
            port: testPort,
            suggestion: suggestion,
            detectedNetwork: networkInfo.detectedNetwork
          });
          resolve();
        }
      });
      
      socket.once('error', (err) => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          
          // Get source IP for network detection (only relevant for timeout errors)
          const sourceIP = socket.localAddress || 'unknown';
          const networkInfo = detectNetworkType(sourceIP);
          
          let message = `❌ Connection failed: ${err.message}`;
          let suggestion = '';
          let detectedNetwork = null;
          
          if (err.code === 'ENOTFOUND') {
            message = `❌ Host not found: ${cleanHost}. Please verify the SMTP hostname is correct.`;
            suggestion = 'Common hosts: smtp.gmail.com, smtp-mail.outlook.com';
          } else if (err.code === 'ECONNREFUSED') {
            message = `❌ Connection refused on port ${testPort}. The server is not accepting connections.`;
            suggestion = 'Check if the port number is correct';
          } else if (err.code === 'ETIMEDOUT') {
            message = `❌ Connection timeout. Port ${testPort} appears to be blocked.`;
            suggestion = getSuggestion(
              networkInfo.isVPN,
              'This is likely a firewall or network restriction issue'
            );
            detectedNetwork = networkInfo.detectedNetwork;
          }
          
          const response = { 
            success: false,
            message: message,
            error: err.code,
            host: cleanHost,
            port: testPort,
            suggestion: suggestion
          };
          
          if (detectedNetwork) {
            response.detectedNetwork = detectedNetwork;
          }
          
          res.status(400).json(response);
          resolve();
        }
      });
      
      socket.connect(testPort, cleanHost);
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
