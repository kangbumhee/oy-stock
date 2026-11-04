const { createHash } = require('node:crypto');

function matchesIfNoneMatch(value, etag) {
  if (typeof value !== 'string') return false;
  const current = etag.replace(/^W\//, '');
  return value.split(',').some((candidate) => {
    const tag = candidate.trim();
    return tag === '*' || tag.replace(/^W\//, '') === current;
  });
}

function sendRankingResponse(req, res, data) {
  // Hash the full response, not updatedAt: rolling windows can change while the
  // stored file stays unchanged. Weak validators also work after CDN compression.
  const digest = createHash('sha256').update(JSON.stringify(data)).digest('base64url');
  const etag = 'W/"oy-ranking-' + digest + '"';
  res.setHeader('ETag', etag);
  if (matchesIfNoneMatch(req.headers && req.headers['if-none-match'], etag)) {
    res.status(304).end();
    return;
  }
  res.status(200).json(data);
}

module.exports = { sendRankingResponse };
