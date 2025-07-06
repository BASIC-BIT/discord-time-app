// Quick test script for the HammerTime API
const http = require('http');

const API_BASE = 'http://localhost:8080';
const API_KEY = 'STATIC_KEY_123';

function makeRequest(path, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 8080,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'X-API-Version': '1'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);
    
    if (data) {
      req.write(JSON.stringify(data));
    }
    
    req.end();
  });
}

async function runTests() {
  console.log('🧪 Testing HammerTime API...\n');

  try {
    // Test 1: Health check
    console.log('1. Health check...');
    const health = await makeRequest('/health');
    console.log(`   Status: ${health.status}`);
    console.log(`   Response: ${health.data.status || 'error'}\n`);

    // Test 2: Parse endpoint
    console.log('2. Parse endpoint...');
    const parseResult = await makeRequest('/parse', 'POST', {
      text: 'tomorrow at 2pm',
      tz: 'America/New_York'
    });
    console.log(`   Status: ${parseResult.status}`);
    if (parseResult.data.epoch) {
      console.log(`   Epoch: ${parseResult.data.epoch}`);
      console.log(`   Format: ${parseResult.data.suggestedFormatIndex}`);
      console.log(`   Confidence: ${parseResult.data.confidence}`);
    } else {
      console.log(`   Error: ${JSON.stringify(parseResult.data)}`);
    }
    console.log();

    // Test 3: Stats endpoint
    console.log('3. Stats endpoint...');
    const stats = await makeRequest('/stats');
    console.log(`   Status: ${stats.status}`);
    if (stats.data.usage) {
      console.log(`   Total requests: ${stats.data.usage.total}`);
    }
    console.log();

    console.log('✅ Tests completed!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.log('\n💡 Make sure the API server is running:');
    console.log('   cd api && npm run dev');
    console.log('   or');
    console.log('   cd api && docker-compose up');
  }
}

runTests(); 