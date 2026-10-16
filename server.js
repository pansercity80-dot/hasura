const express = require('express');
const cors = require('cors');
const YTDlpWrap = require('yt-dlp-wrap').default;

const app = express();
app.use(cors());
app.use(express.json());

const ytDlp = new YTDlpWrap();

// === /api/resolve (SSE) ===
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
    await new Promise(r => setTimeout(r, 400));

    send('stage', { step: 'resolve', text: 'Mendeteksi platform...' });
    await new Promise(r => setTimeout(r, 500));

    send('stage', { step: 'probe', text: 'Mengambil data media...' });

    const info = await ytDlp.getVideoInfo(url);

    const media = [];
    if (info.formats) {
      info.formats
        .filter(f => f.url && (f.vcodec !== 'none' || f.acodec !== 'none'))
        .slice(0, 8)
        .forEach(f => {
          media.push({
            url: f.url,
            quality: f.format_note || f.resolution || f.format_id,
            format: f.ext || 'mp4',
            sizeHuman: f.filesize ? (f.filesize / 1024 / 1024).toFixed(1) + ' MB' : null,
            label: f.format_note || ''
          });
        });
    }

    const result = {
      platform: info.extractor_key?.toLowerCase() || 'unknown',
      title: info.title || 'Tanpa judul',
      thumbnail: info.thumbnail,
      duration: info.duration,
      creator: {
        name: info.uploader || info.channel || 'Unknown',
        username: info.uploader_id || info.channel_id || null,
        avatar: null
      },
      stats: {
        likes: info.like_count || null,
        plays: info.view_count || null
      },
      media,
      sourceUrl: url
    };

    send('result', result);
  } catch (err) {
    console.error(err);
    send('fail', { code: 'RESOLVE_FAILED', message: err.message });
  }

  res.end();
});

// === /api/dl (proxy download) ===
app.get('/api/dl', async (req, res) => {
  const { url, name } = req.query;
  if (!url) return res.status(400).send('Missing url');

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    if (!response.ok) throw new Error('Failed to fetch media');

    res.setHeader('Content-Disposition', `attachment; filename="${name || 'media.mp4'}"`);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    res.status(500).send('Download failed');
  }
});

app.get('/', (req, res) => {
  res.send('Hashura Backend is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
