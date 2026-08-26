const {
  createDeviceRecord,
  normalizeDeviceId,
  normalizeDeviceSecret,
  verifyDeviceSecret
} = require('./_core');
const { HttpError, deviceCredentials } = require('./_http');
const { mutateDevice, readDevice } = require('./_store');

async function authenticateDevice(req, options) {
  const credentials = deviceCredentials(req);
  const deviceId = normalizeDeviceId(credentials.deviceId);
  const deviceSecret = normalizeDeviceSecret(credentials.deviceSecret);
  if (!deviceId || !deviceSecret) throw new HttpError(401, 'device_auth_required');

  const loaded = await readDevice(deviceId);
  if (!loaded.record) {
    if (!(options && options.allowCreate)) throw new HttpError(401, 'device_auth_failed');
    return {
      ...loaded,
      record: createDeviceRecord(deviceId, deviceSecret),
      created: true
    };
  }
  if (!verifyDeviceSecret(deviceId, deviceSecret, loaded.record.secretHash)) {
    throw new HttpError(401, 'device_auth_failed');
  }
  return { ...loaded, created: false };
}

async function mutateAuthenticatedDevice(req, options, mutation) {
  const credentials = deviceCredentials(req);
  const deviceId = normalizeDeviceId(credentials.deviceId);
  const deviceSecret = normalizeDeviceSecret(credentials.deviceSecret);
  if (!deviceId || !deviceSecret) throw new HttpError(401, 'device_auth_required');
  const allowCreate = Boolean(options && options.allowCreate);

  return mutateDevice(deviceId, async (currentRecord, context) => {
    let record = currentRecord;
    if (!record) {
      if (!allowCreate) throw new HttpError(401, 'device_auth_failed');
      record = createDeviceRecord(deviceId, deviceSecret);
    } else if (!verifyDeviceSecret(deviceId, deviceSecret, record.secretHash)) {
      throw new HttpError(401, 'device_auth_failed');
    }
    const outcome = (await mutation(record, {
      ...context,
      created: !currentRecord
    })) || { changed: false };
    return { ...outcome, record };
  });
}

module.exports = { authenticateDevice, mutateAuthenticatedDevice };
