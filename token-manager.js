require('dotenv').config();
const https = require('https');
const fs = require('fs');

const SHOP = 'shtykv-wy.myshopify.com';
const CLIENT_ID = '541fedd1946f0e71f97c0b236770765e';
const CLIENT_SECRET = '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';
const TOKEN_FILE = __dirname + '/.token-cache.json';

async function generateToken() {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    });

    const options = {
      hostname: SHOP,
      path: '/admin/oauth/access_token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': postData.length
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.access_token) {
            const tokenData = {
              token: data.access_token,
              expires_at: Date.now() + (data.expires_in * 1000),
              generated_at: new Date().toISOString()
            };
            
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
            
            console.log('✅ Token generato!');
            console.log('⏰ Scade:', new Date(tokenData.expires_at).toLocaleString('it-IT'));
            
            resolve(data.access_token);
          } else {
            reject(new Error('Token non ricevuto: ' + body));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function getCachedToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      const oneHourBeforeExpiry = data.expires_at - (60 * 60 * 1000);
      
      if (Date.now() < oneHourBeforeExpiry) {
        console.log('✅ Token dalla cache');
        return data.token;
      }
    }
  } catch (e) {
    console.log('⚠️ Cache non valida');
  }
  return null;
}

async function getToken() {
  const cached = getCachedToken();
  if (cached) return cached;
  
  console.log('🔑 Genero nuovo token...');
  return await generateToken();
}

module.exports = { getToken };

if (require.main === module) {
  getToken()
    .then(token => {
      console.log('\n📋 TOKEN:');
      console.log(token);
      console.log('\n✅ Pronto per essere usato!');
    })
    .catch(err => {
      console.error('❌ Errore:', err.message);
      process.exit(1);
    });
}
