const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json());

const BIN_DIR = path.join(__dirname, 'bin');
const YTDLP_PATH = path.join(BIN_DIR, 'yt-dlp');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (u) => {
      https.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error('Download failed: ' + res.statusCode));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          fs.chmodSync(dest, 0o755);
          resolve();
        });
      }).on('error', reject);
    };
    request(url);
  });
}

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_PATH)) {
    try {
      await execFileAsync(YTDLP_PATH, ['--version'], { timeout: 10000 });
      return YTDLP_PATH;
    } catch (e) {
      try { fs.unlinkSync(YTDLP_PATH); } catch (_) {}
    }
  }

  console.log('Downloading yt-dlp...');
  fs.mkdirSync(BIN_DIR, { recursive: true });
  await download(
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
    YTDLP_PATH
  );
  console.log('yt-dlp ready');
  return YTDLP_PATH;
}

async function getInfo(url) {
  const bin = await ensureYtDlp();
  const { stdout, stderr } = await execFileAsync(bin, [
    '--dump-json',
    '--no-warnings',
    '--no-check-certificates',
    '--geo-bypass',
    url
  ], {
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });

  if (!stdout || !stdout.trim()) {
    throw new Error('Empty response from yt-dlp: ' + (stderr || 'no stderr'));
  }

  return JSON.parse(stdout);
}

app.get('/api/resolve', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ code: 'BAD_URL' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    send('stage', { step: 'session', text: 'Menyiapkan sesi...' });
    await new Promise(r => setTimeout(r, 200));

    send('stage', { step: 'resolve', text: 'Mendeteksi platform...' });
    await new Promise(r => setTimeout(r, 200));

    send('stage', { step: 'probe', text: 'Mengambil data media...' });

    const info = await getInfo(url);

    const media = [];
    const formats = (info.formats || []).filter(f => f.url);

    const combined = formats
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    const videoOnly = formats
      .filter(f => f.vcodec !== 'none' && f.acodec === 'none')
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    const audioOnly = formats
      .filter(f => f.acodec !== 'none' && f.vcodec === 'none')
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));

    const pick = [...combined.slice(0, 4), ...videoOnly.slice(0, 3), ...audioOnly.slice(0, 3)];

    for (const f of pick) {
      const size = f.filesize || f.filesize_approx;
      media.push({
        url: f.url,
        quality: f.format_note || (f.height ? f.height + 'p' : null) || f.resolution || f.format_id,
        format: f.ext || 'mp4',
        sizeHuman: size ? (size / 1024 / 1024).toFixed(1) + ' MB' : null,
        label: f.format_note || ''
      });
    }

    if (media.length === 0 && info.url) {
      media.push({
        url: info.url,
        quality: 'default',
        format: info.ext || 'mp4',
        sizeHuman: null,
        label: ''
      });
    }

    const result = {
      platform: (info.extractor_key || info.extractor || 'unknown').toLowerCase(),
      title: info.title || 'Tanpa judul',
      thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : null),
      duration: info.duration,
      creator: {
        name: info.uploader || info.channel || info.creator || 'Unknown',
        username: info.uploader_id || info.channel_id || null,
        avatar: null
      },
      stats: {
        likes: info.like_count || null,
        plays: info.view_count || null,
        comments: info.comment_count || null
      },
      media,
      sourceUrl: url
    };

    send('result', result);
  } catch (err) {
    console.error('Resolve error:', err.message || err);
    send('fail', {
      code: 'RESOLVE_FAILED',
      message: String(err.message || err).slice(0, 300)
    });
  }

  res.end();
});

app.get('/api/dl', async (req, res) => {
  const { url, name } = req.query;
  if (!url) return res.status(400).send('Missing url');

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': 'https://www.youtube.com/'
      },
      redirect: 'follow'
    });

    if (!response.ok) throw new Error('HTTP ' + response.status);

    res.setHeader('Content-Disposition', `attachment; filename="${name || 'media.mp4'}"`);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    if (response.headers.get('content-length')) {
      res.setHeader('Content-Length', response.headers.get('content-length'));
    }

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error('DL error:', err);
    res.status(500).send('Download failed');
  }
});

app.get('/', (req, res) => {
  res.send('Hashura Backend is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port', PORT);
  ensureYtDlp().catch(e => console.error('yt-dlp setup failed:', e.message));
});
