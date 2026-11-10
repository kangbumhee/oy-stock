module.exports = function curatorRetired(req, res) {
  res.statusCode = 410;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify({
    success: false,
    removed: true,
    error: 'curator_link_generation_removed'
  }));
};
