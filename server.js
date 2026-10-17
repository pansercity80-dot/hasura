const express = require('express');
const cors = require('cors');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const BIN_DIR = path.join(__dirname, 'bin');
const YTDLP_PATH = path.join(BIN_DIR, 'yt-dlp');

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_PATH)) return YTDLP_PATH;

  console.log('Downloading yt-dlp binary...');
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
  
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(YTDLP_PATH);
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        https.get(res.headers.location, (res2) => {
          res2.pipe(file);
          file.on('finish', () => {
            file.close();
            fs.chmodSync(YTDLP_PATH, 0o755);
            resolve();
          });
        }).on('error', reject);
      } else {
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          fs.chmodSync(YTDLP_PATH, 0o755);
          resolve();
        });
      }
    }).on('error', reject);
  });

  console.log('yt-dlp downloaded');
  return YTDLP_PATH;
}

let ytDlp = null;

async function getYtDlp() {
  if (!ytDlp) {
    const bin = await ensureYtDlp();
    ytDlp = new YTDlpWrap(bin);
  }
  return ytDlp;
}

app.get('/api/resolve', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ code: 'BAD_URL' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    send('stage', { step: 'session', text: 'Menyiapkan sesi...' });
    await new Promise(r => setTimeout(r, 300));

    send('stage', { step: 'resolve', text: 'Mendeteksi platform...' });
    await new Promise(r => setTimeout(r, 300));

    send('stage', { step: 'probe', text: 'Mengambil data media...' });

    const ytdlp = await getYtDlp();
    const info = await ytdlp.getVideoInfo(url);

    const media = [];
    if (info.formats) {
      const formats = info.formats
        .filter(f => f.url && (f.vcodec !== 'none' || f.acodec !== 'none'))
        .sort((a, b) => {
          const aScore = (a.vcodec !== 'none' ? 10 : 0) + (a.acodec !== 'none' ? 5 : 0) + (a.height || 0) / 100;
          const bScore = (b.vcodec !== 'none' ? 10 : 0) + (b.acodec !== 'none' ? 5 : 0) + (b.height || 0) / 100;
          return bScore - aScore;
        })
        .slice(0, 10);

      formats.forEach(f => {
        media.push({
          url: f.url,
          quality: f.format_note || (f.height ? f.height + 'p' : null) || f.resolution || f.format_id,
          format: f.ext || 'mp4',
          sizeHuman: f.filesize ? (f.filesize / 1024 / 1024).toFixed(1) + ' MB' : (f.filesize_approx ? (f.filesize_approx / 1024 / 1024).toFixed(1) + ' MB' : null),
          label: f.format_note || ''
        });
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
    send('fail', { code: 'RESOLVE_FAILED', message: String(err.message || err) });
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
        'Accept': '*/*'
      },
      redirect: 'follow'
    });

    if (!response.ok) throw new Error('Failed to fetch media: ' + response.status);

    const filename = name || 'media.mp4';
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
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
    res.status(500).send('Download failed: ' + err.message);
  }
});

app.get('/', (req, res) => {
  res.send('Hashura Backend is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  ensureYtDlp().catch(e => console.error('Failed to download yt-dlp:', e.message));
});
