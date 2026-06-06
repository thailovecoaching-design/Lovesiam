const https = require('https');
const http = require('http');
const { URL } = require('url');

exports.handler = async function(event, context) {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { videoUrl, sourceLang } = JSON.parse(event.body);
    if (!videoUrl) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'videoUrl required' }) };
    }

    const OPENAI_KEY = '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';

    // Step 1: Download video from Cloudinary
    console.log('Downloading video from:', videoUrl);
    const videoBuffer = await downloadFile(videoUrl);
    console.log('Video downloaded, size:', videoBuffer.length);

    // Step 2: Transcribe with Whisper
    console.log('Transcribing with Whisper...');
    const transcription = await transcribeWithWhisper(videoBuffer, sourceLang, OPENAI_KEY);
    console.log('Transcription:', transcription);

    // Step 3: Translate with GPT
    const targetLang = sourceLang === 'th' ? 'fr' : 'th';
    console.log('Translating to:', targetLang);
    const translation = await translateWithGPT(transcription, sourceLang, targetLang, OPENAI_KEY);
    console.log('Translation:', translation);

    // Step 4: Split into subtitle segments (max 3 sentences each)
    const srcSegments = splitIntoSegments(transcription);
    const tgtSegments = splitIntoSegments(translation);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        sourceLang,
        targetLang,
        transcription,
        translation,
        segments: srcSegments.map((s, i) => ({
          f: sourceLang === 'fr' ? s : (tgtSegments[i] || ''),
          t: sourceLang === 'th' ? s : (tgtSegments[i] || '')
        }))
      })
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Transcription failed' })
    };
  }
};

// Download file from URL
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const chunks = [];
    client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        downloadFile(res.headers.location).then(resolve).catch(reject);
        return;
      }
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Transcribe with Whisper API
function transcribeWithWhisper(audioBuffer, lang, apiKey) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    
    // Build multipart form data
    const filename = 'audio.mp4';
    const mimeType = 'video/mp4';
    
    let body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      audioBuffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${lang}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext\r\n`),
      Buffer.from(`--${boundary}--\r\n`)
    ]);

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data.trim());
        } else {
          reject(new Error(`Whisper error ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Translate with GPT
function translateWithGPT(text, sourceLang, targetLang, apiKey) {
  return new Promise((resolve, reject) => {
    const langNames = { fr: 'French', th: 'Thai', en: 'English' };
    const prompt = `Translate this ${langNames[sourceLang]} text to ${langNames[targetLang]}. 
Keep the same tone and natural speech style. 
Return ONLY the translation, nothing else.

Text: ${text}`;

    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.3
    });

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0]) {
            resolve(json.choices[0].message.content.trim());
          } else {
            reject(new Error('GPT error: ' + data));
          }
        } catch (e) {
          reject(new Error('Parse error: ' + data));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Split text into 3-4 segments for subtitles
function splitIntoSegments(text) {
  if (!text) return ['', '', ''];
  // Split by sentence endings
  const sentences = text.match(/[^.!?。]+[.!?。]*/g) || [text];
  const segCount = 3;
  const perSeg = Math.ceil(sentences.length / segCount);
  const segments = [];
  for (let i = 0; i < segCount; i++) {
    const chunk = sentences.slice(i * perSeg, (i + 1) * perSeg).join(' ').trim();
    segments.push(chunk || '');
  }
  return segments;
}
