const nodemailer = require('nodemailer');

class EmailSender {
  constructor(smtpConfig, io = null) {
    this.io = io; // Socket.io instance for progress updates
    const port = parseInt(smtpConfig.port) || 587;
    const isSecure = port === 465;
    
    // Base transporter configuration (enhanced timeouts from working implementation)
    const transporterConfig = {
      host: smtpConfig.host,
      port: port,
      secure: isSecure, // true for 465 (SSL), false for 587 (STARTTLS)
      auth: {
        user: smtpConfig.user,
        pass: smtpConfig.pass
      },
      // Increased timeouts for slower connections (matching working implementation)
      connectionTimeout: 60000, // 60 seconds (increased for better reliability)
      greetingTimeout: 30000,   // 30 seconds
      socketTimeout: 60000,     // 60 seconds
      debug: false, // Set to true for debugging SMTP issues
      logger: false // Set to true for SMTP logging
    };
    

    // Configure TLS/SSL based on port
    if (isSecure) {
      // Port 465 - SSL/TLS connection (immediate SSL)
      transporterConfig.tls = {
        // Do not fail on invalid certificates (some mail servers have self-signed certs)
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
        // Allow legacy TLS versions for compatibility with older servers
        maxVersion: undefined
      };
      // For port 465, we need secure: true (already set above)
      // Some servers may need this explicit setting
      transporterConfig.secure = true;
    } else {
      // Port 587 - STARTTLS connection (upgrade to TLS after connection)
      transporterConfig.requireTLS = true; // Require TLS upgrade
      transporterConfig.tls = {
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2'
      };
    }
    
    this.transporter = nodemailer.createTransport(transporterConfig);
    
    // Format "from" field with optional sender name
    // Format: "Name <email@example.com>" or just "email@example.com"
    const email = smtpConfig.from || smtpConfig.user;
    if (smtpConfig.senderName && smtpConfig.senderName.trim()) {
      this.from = `"${smtpConfig.senderName.trim()}" <${email}>`;
    } else {
      this.from = email;
    }
  }

  /**
   * Verify SMTP connection
   */
  async verify() {
    const config = this.transporter.options;
    console.log(`[SMTP] Attempting connection to ${config.host}:${config.port} (secure: ${config.secure})`);
    
    try {
      // Use a timeout wrapper to provide better error messages
      const verifyPromise = this.transporter.verify();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Connection timeout after 25 seconds.')), 25000);
      });
      
      await Promise.race([verifyPromise, timeoutPromise]);
      console.log(`[SMTP] ✅ Connection verified successfully to ${config.host}:${config.port}`);
      return { success: true, message: 'SMTP connection verified successfully' };
    } catch (error) {
      console.error(`[SMTP] ❌ Connection failed to ${config.host}:${config.port} - ${error.message}`);
      let errorMessage = error.message;
      
      // Provide more specific error messages
      if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
        errorMessage = 'Connection timeout. Possible causes:\n\n' +
          '1. 🔥 Firewall blocking SMTP ports (587/465) - Check if your firewall allows outbound connections\n' +
          '2. 🌐 Incorrect SMTP host address - Verify the hostname (e.g., smtp.gmail.com, smtp-mail.outlook.com)\n' +
          '3. ⚠️ SMTP server is down or unreachable - Try accessing it from a different network\n' +
          '4. 📶 Network connectivity issues - Check your internet connection\n' +
          '5. 🔌 Corporate/VPN network restrictions - Some networks block SMTP ports\n\n' +
          `💡 Current config: ${config.host}:${config.port} (${config.secure ? 'SSL' : 'STARTTLS'})\n` +
          '💡 Try: Different SMTP host or port, or test from a different network';
      } else if (errorMessage.includes('ECONNREFUSED')) {
        errorMessage = 'Connection refused. Check if:\n' +
          '1. SMTP host and port are correct\n' +
          '2. The SMTP server is running\n' +
          '3. You have network access to the server';
      } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
        errorMessage = 'SMTP host not found. Please verify the hostname is correct.\n\n' +
          'Common SMTP hosts:\n' +
          '• Gmail: smtp.gmail.com\n' +
          '• Outlook/Hotmail: smtp-mail.outlook.com\n' +
          '• Yahoo: smtp.mail.yahoo.com';
      } else if (errorMessage.includes('EAUTH') || errorMessage.includes('authentication') || errorMessage.includes('Invalid login')) {
        errorMessage = 'Authentication failed. Please check:\n' +
          '1. Email address is correct\n' +
          '2. Password is correct\n' +
          '3. For Gmail: Use App Password (not regular password) if 2FA is enabled\n' +
          '4. "Less secure app access" may need to be enabled (for some providers)';
      }
      
      return { success: false, message: errorMessage };
    }
  }

  /**
   * Render email template
   */
  renderTemplate(template, variables = {}) {
    let rendered = template;
    
    // Replace variables like {{variableName}}
    Object.keys(variables).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      rendered = rendered.replace(regex, variables[key] || '');
    });

    return rendered;
  }

  /**
   * Send a single email
   */
  async sendEmail(to, subject, html, text = null, attachments = []) {
    try {
      const mailOptions = {
        from: this.from,
        to: to,
        subject: subject,
        html: html,
        attachments: attachments
      };

      if (text) {
        mailOptions.text = text;
      }

      const info = await this.transporter.sendMail(mailOptions);
      return {
        success: true,
        messageId: info.messageId,
        response: info.response
      };
    } catch (error) {
      // Provide more detailed error information (matching working implementation)
      let errorMessage = error.message;
      
      if (error.code === 'EAUTH') {
        errorMessage = 'Authentication failed. Check your SMTP credentials.';
      } else if (error.code === 'ECONNECTION') {
        errorMessage = 'Connection failed. Check your SMTP settings and network connection.';
      } else if (error.code === 'ETIMEDOUT') {
        errorMessage = 'Connection timeout. Check your network connection and firewall settings.';
      } else if (error.code === 'ECONNREFUSED') {
        errorMessage = 'Connection refused. Check if SMTP host and port are correct.';
      } else if (error.code === 'ENOTFOUND') {
        errorMessage = 'SMTP host not found. Please verify the hostname is correct.';
      }
      
      return {
        success: false,
        error: errorMessage,
        errorCode: error.code
      };
    }
  }

  /**
   * Emit progress update to connected clients
   */
  emitProgress(data) {
    if (this.io) {
      this.io.emit('bulk-send-progress', data);
    }
  }

  /**
   * Send bulk emails (with SMTP verification before sending)
   */
  async sendBulkEmails(emails, subject, htmlTemplate, textTemplate = null, options = {}) {
    // Verify SMTP connection before starting (matching working implementation)
    this.emitProgress({
      message: 'Verifying SMTP connection...',
      sent: 0,
      failed: 0,
      total: emails.length,
      percentage: 0
    });

    try {
      await this.transporter.verify();
      this.emitProgress({
        message: 'SMTP connection verified! Starting to send emails...',
        sent: 0,
        failed: 0,
        total: emails.length,
        percentage: 0
      });
    } catch (error) {
      const errorMsg = `Failed to verify SMTP connection: ${error.message}`;
      this.emitProgress({
        message: `Error: ${errorMsg}`,
        sent: 0,
        failed: 0,
        total: emails.length,
        percentage: 0
      });
      throw new Error(errorMsg);
    }

    const results = {
      sent: [],
      failed: [],
      total: emails.length
    };

    const batchSize = options.batchSize || 5;
    const delay = options.delay || 1000; // Delay between batches in ms

    // Emit initial progress
    this.emitProgress({
      message: `Starting to send ${emails.length} emails...`,
      sent: 0,
      failed: 0,
      total: emails.length,
      percentage: 0
    });

    for (let i = 0; i < emails.length; i += batchSize) {
      const batch = emails.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(emails.length / batchSize);
      
      // Emit batch start progress
      this.emitProgress({
        message: `Sending batch ${batchNumber} of ${totalBatches} (${i + 1}-${Math.min(i + batchSize, emails.length)} of ${emails.length})...`,
        sent: results.sent.length,
        failed: results.failed.length,
        total: emails.length,
        percentage: Math.round((i / emails.length) * 100)
      });
      
      const promises = batch.map(async (emailItem) => {
        // Handle both object and string email formats
        const emailAddress = emailItem.email || emailItem;
        
        // Skip if email address is invalid
        if (!emailAddress || typeof emailAddress !== 'string') {
          return {
            email: emailAddress || 'unknown',
            success: false,
            error: 'Invalid email address'
          };
        }

        const variables = {
          email: emailAddress,
          name: emailItem.name || emailItem.username || 'Contributor',
          username: emailItem.username || '',
          repository: emailItem.repository || ''
        };

        const html = this.renderTemplate(htmlTemplate, variables);
        const text = textTemplate ? this.renderTemplate(textTemplate, variables) : null;

        const result = await this.sendEmail(emailAddress, subject, html, text, options.attachments);
        
        return {
          email: emailAddress,
          ...result
        };
      });

      const batchResults = await Promise.all(promises);
      
      batchResults.forEach(result => {
        if (result.success) {
          results.sent.push(result);
        } else {
          results.failed.push(result);
          // Log failed email details (matching working implementation)
          if (this.io) {
            console.error(`❌ Failed to send email to ${result.email}: ${result.error || 'Unknown error'}`);
          }
        }
      });

      // Emit batch complete progress
      const currentSent = results.sent.length;
      const currentFailed = results.failed.length;
      const percentage = Math.round(((currentSent + currentFailed) / emails.length) * 100);
      
      this.emitProgress({
        message: `Batch ${batchNumber} complete. Sent: ${currentSent}, Failed: ${currentFailed}`,
        sent: currentSent,
        failed: currentFailed,
        total: emails.length,
        percentage: percentage
      });

      // Delay before next batch to avoid overwhelming the SMTP server
      if (i + batchSize < emails.length) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // Emit final progress
    this.emitProgress({
      message: `Completed! Sent: ${results.sent.length}, Failed: ${results.failed.length}`,
      sent: results.sent.length,
      failed: results.failed.length,
      total: emails.length,
      percentage: 100
    });

    // Log summary (matching working implementation)
    console.log(`\n📧 Email sending completed:`);
    console.log(`✅ Sent: ${results.sent.length}`);
    console.log(`❌ Failed: ${results.failed.length}`);
    
    if (results.failed.length > 0) {
      console.log('\nFailed emails:');
      results.failed.forEach(failed => {
        console.log(`  ${failed.email}: ${failed.error || 'Unknown error'}`);
      });
    }

    // Close transporter connection (matching working implementation)
    if (this.transporter && typeof this.transporter.close === 'function') {
      this.transporter.close();
    }

    return results;
  }
}

module.exports = EmailSender;
