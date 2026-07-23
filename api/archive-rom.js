const ROM_EXTENSIONS = {
  sega_genesis_library: ['.bin', '.gen', '.md', '.smd', '.zip'],
  sega_sms_library: ['.sms', '.zip'],
  gamegear_library: ['.gg', '.zip'],
  tg16_library: ['.pce', '.zip'],
  atari_2600_library: ['.a26', '.bin', '.zip'],
  atari_7800_library: ['.a78', '.bin', '.zip'],
  atari_5200_library: ['.a52', '.bin', '.zip'],
  ngp_library: ['.ngp', '.ngc', '.zip'],
  'wonderswan-library': ['.ws', '.wsc', '.zip'],
  _default: ['.zip', '.bin', '.rom']
};

function isValidIdentifier(id) {
  return /^[A-Za-z0-9._-]{1,120}$/.test(id || '');
}

function pickRomFile(files, category) {
  const exts = ROM_EXTENSIONS[category] || ROM_EXTENSIONS._default;
  const candidates = (files || []).filter((file) => {
    if (!file || !file.name) return false;
    const name = String(file.name).toLowerCase();
    if (name.includes('/')) return false;
    if (/\.(txt|xml|json|png|jpg|jpeg|gif|webp|sqlite|torrent|meta)$/i.test(name)) return false;
    return exts.some((ext) => name.endsWith(ext));
  });

  candidates.sort((a, b) => {
    const ao = a.source === 'original' ? 0 : 1;
    const bo = b.source === 'original' ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const as = Number(a.size || 0);
    const bs = Number(b.size || 0);
    return bs - as;
  });

  return candidates[0] || null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.end('Method not allowed');
    return;
  }

  try {
    const id = String((req.query && req.query.id) || '');
    const category = String((req.query && req.query.cat) || '_default');

    if (!isValidIdentifier(id)) {
      res.statusCode = 400;
      res.end('Invalid archive identifier');
      return;
    }

    const metadataResponse = await fetch('https://archive.org/metadata/' + encodeURIComponent(id), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OliveStockArcade/1.0'
      },
      redirect: 'follow'
    });

    if (!metadataResponse.ok) {
      res.statusCode = metadataResponse.status;
      res.end('Archive metadata not available');
      return;
    }

    const metadata = await metadataResponse.json();
    const rom = pickRomFile(metadata.files, category);

    if (!rom) {
      res.statusCode = 404;
      res.end('ROM file not found for this archive item');
      return;
    }

    const archivePath = '/download/' + id + '/' + encodeURIComponent(rom.name);
    const proxyUrl = '/api/archive-file?path=' + encodeURIComponent(archivePath);
    res.statusCode = 302;
    res.setHeader('Location', proxyUrl);
    res.end();
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(err.message || 'Archive ROM lookup failed');
  }
};
