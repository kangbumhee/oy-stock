const MAX_CACHED_BYTES = 32 * 1024 * 1024;

function createConditionalBlobStore({ get, put, pathname, emptyStore, readText }) {
  let cached = null;
  let writeEpoch = 0;
  let readSequence = 0;
  let completedSequence = 0;

  function invalidate() {
    writeEpoch += 1;
    cached = null;
  }

  async function fetchStore(etag) {
    const options = { access: 'private', useCache: false };
    if (etag) options.ifNoneMatch = etag;
    try {
      return await get(pathname, options);
    } catch (error) {
      if (error && (error.name === 'BlobNotFoundError' || /not found/i.test(error.message || ''))) {
        return null;
      }
      throw error;
    }
  }

  async function read(options) {
    const snapshot = cached;
    const epoch = writeEpoch;
    const sequence = ++readSequence;
    function remember(value) {
      // A read started before a write, or an older overlapping response, cannot
      // repopulate the process cache after more recent work has completed.
      if (epoch === writeEpoch && sequence >= completedSequence) {
        completedSequence = sequence;
        cached = value;
      }
    }
    function report(statusCode, bodyBytes) {
      if (options && typeof options.onRead === 'function') {
        options.onRead({ statusCode, bodyBytes });
      }
    }

    try {
      let result = await fetchStore(snapshot && snapshot.etag);
      if (result && result.statusCode === 304) {
        if (snapshot) {
          // The validator belongs to this request's snapshot. A concurrent read
          // may have replaced the global cache while this request was in flight.
          // Blob can omit ETag on 304, so retain the original validator as well.
          if (epoch === writeEpoch) completedSequence = Math.max(completedSequence, sequence);
          report(304, 0);
          return JSON.parse(snapshot.text);
        }
        result = await fetchStore();
      }
      if (!result) {
        remember(null);
        return emptyStore();
      }
      if ((result.statusCode && result.statusCode !== 200) || !result.stream) {
        throw new Error('Hot ranking store read failed');
      }
      const text = await readText(result.stream);
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Hot ranking store data is invalid');
      }
      const bodyBytes = Buffer.byteLength(text, 'utf8');
      const etag = result.blob && result.blob.etag;
      remember(etag && bodyBytes <= MAX_CACHED_BYTES ? { text, etag } : null);
      report(200, bodyBytes);
      return parsed;
    } catch (error) {
      remember(null);
      throw error;
    }
  }

  async function write(store) {
    // Do not seed the cache from a write: another writer may already have
    // superseded it. Revalidate the origin on the next read instead.
    invalidate();
    try {
      return await put(pathname, JSON.stringify(store), {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
        cacheControlMaxAge: 60
      });
    } finally {
      invalidate();
    }
  }

  return { read, write };
}

module.exports = { createConditionalBlobStore };
